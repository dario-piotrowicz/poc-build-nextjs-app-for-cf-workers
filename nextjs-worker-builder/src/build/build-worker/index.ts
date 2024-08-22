import { NextjsAppPaths } from "../../nextjsPaths";
import { build, Plugin } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, readFile, writeFile } from "node:fs/promises";

import { globSync } from "glob";

let fixRequires: Plugin = {
	name: "replaceRelative",
	setup(build) {
		// Note: we (empty) shim require-hook modules as they generate problematic code that uses requires
		build.onResolve({ filter: /^\.\/require-hook$/ }, (args) => ({
			path: `${__dirname}/templates/shims/empty.ts`,
		}));
	},
};

/**
 * Using the Next.js build output in the `.next` directory builds a workerd compatible output
 *
 * @param outputDir the directory where to save the output
 * @param nextjsAppPaths
 */
export async function buildWorker(
	outputDir: string,
	nextjsAppPaths: NextjsAppPaths
): Promise<void> {
	const workerEntrypoint = `${__dirname}/templates/worker.ts`;
	const workerOutputFile = `${outputDir}/assets/_worker.js`;
	const nextConfigStr =
		readFileSync(nextjsAppPaths.standaloneAppDir + "/server.js", "utf8")?.match(
			/const nextConfig = ({.+?})\n/
		)?.[1] ?? {};

	console.log(`\x1b[35m⚙️ Bundling the worker file...\n\x1b[0m`);
	await build({
		entryPoints: [workerEntrypoint],
		bundle: true,
		outfile: workerOutputFile,
		format: "esm",
		target: "esnext",
		minify: false,
		plugins: [fixRequires],
		alias: {
			// Note: we apply an empty shim to next/dist/compiled/ws because it generates two `eval`s:
			//   eval("require")("bufferutil");
			//   eval("require")("utf-8-validate");
			"next/dist/compiled/ws": `${__dirname}/templates/shims/empty.ts`,
			// Note: we apply an empty shim to next/dist/compiled/edge-runtime since (amongst others) it generated the following `eval`:
			//   eval(getModuleCode)(module, module.exports, throwingRequire, params.context, ...Object.values(params.scopedContext));
			//   which comes from https://github.com/vercel/edge-runtime/blob/6e96b55f/packages/primitives/src/primitives/load.js#L57-L63
			// QUESTION: Why did I encountered this but mhart didn't?
			"next/dist/compiled/edge-runtime": `${__dirname}/templates/shims/empty.ts`,
			// Note: we need to stub out `@opentelemetry/api` as that is problematic and doesn't get properly bundled...
			critters: `${__dirname}/templates/shims/empty.ts`,
			// Note: we need to stub out `@opentelemetry/api` as it is problematic
			"@opentelemetry/api": `${__dirname}/templates/shims/opentelemetry.ts`,
			// `@next/env` is a library Next.js uses for loading dotenv files, for obvious reasons we need to stub it here
			// source: https://github.com/vercel/next.js/tree/0ac10d79720/packages/next-env
			"@next/env": `${__dirname}/templates/shims/env.ts`,
		},
		define: {
			// config file used by Next.js, see: https://github.com/vercel/next.js/blob/68a7128/packages/next/src/build/utils.ts#L2137-L2139
			"process.env.__NEXT_PRIVATE_STANDALONE_CONFIG":
				JSON.stringify(nextConfigStr),
			// Next.js tried to access __dirname so we need to define it
			__dirname: '""',
			// Note: we need the __non_webpack_require__ variable declared as it is used by next-server:
			// https://github.com/vercel/next.js/blob/be0c3283/packages/next/src/server/next-server.ts#L116-L119
			__non_webpack_require__: "require",
			// The next.js server can run in minimal mode: https://github.com/vercel/next.js/blob/aa90fe9bb/packages/next/src/server/base-server.ts#L510-L511
			// this avoids some extra (/problematic) `require` calls, such as here: https://github.com/vercel/next.js/blob/aa90fe9bb/packages/next/src/server/next-server.ts#L1259
			// that's wht we enable it
			"process.env.NEXT_PRIVATE_MINIMAL_MODE": "true",
			// Ask mhart if he can explain why the `define`s below are necessary
			"process.env.NEXT_RUNTIME": '"nodejs"',
			"process.env.NODE_ENV": '"production"',
			"process.env.NEXT_MINIMAL": "true",
		},
		// We need to set platform to node so that esbuild doesn't complain about the node imports
		platform: "node",
	});

	await updateWorkerBundledCode(workerOutputFile, nextjsAppPaths);

	console.log(`\x1b[35m⚙️ Copying asset files...\n\x1b[0m`);
	await cp(`${nextjsAppPaths.dotNextDir}/static`, `${outputDir}/assets/_next`, {
		recursive: true,
	});

	console.log(`\x1b[35mWorker saved in \`${workerOutputFile}\` 🚀\n\x1b[0m`);
}

/**
 * This function applies string replacements on the bundled worker code necessary to get it to run in workerd
 *
 * Needless to say all the logic in this function is something we should avoid as much as possible!
 *
 * @param workerOutputFile
 * @param nextjsAppPaths
 */
async function updateWorkerBundledCode(
	workerOutputFile: string,
	nextjsAppPaths: NextjsAppPaths
): Promise<void> {
	let workerContents = await readFile(workerOutputFile, "utf8");

	// ultra hack (don't remember/know why it's needed)
	workerContents = workerContents
		.replace(/__require\d?\(/g, "require(")
		.replace(/__require\d?\./g, "require.");

	// The next-server code gets the buildId from the filesystem, resulting in a `[unenv] fs.readFileSync is not implemented yet!` error
	// so we add an early return to the `getBuildId` function so that the `readyFileSync` is never encountered
	// (source: https://github.com/vercel/next.js/blob/15aeb92efb34c09a36/packages/next/src/server/next-server.ts#L438-L451)
	// Note: we could/should probably just patch readFileSync here or something!
	workerContents = workerContents.replace(
		"getBuildId() {",
		`getBuildId() {
      return ${JSON.stringify(
				readFileSync(
					`${nextjsAppPaths.standaloneAppDotNextDir}/BUILD_ID`,
					"utf-8"
				)
			)};
    `
	);

	// Same as above, the next-server code loads the manifests with `readyFileSync` and we want to avoid that
	// (source: https://github.com/vercel/next.js/blob/15aeb92e/packages/next/src/server/load-manifest.ts#L34-L56)
	// Note: we could/should probably just patch readFileSync here or something!
	const manifestJsons = globSync(
		`${nextjsAppPaths.standaloneAppDotNextDir}/**/*-manifest.json`
	).map((file) => file.replace(nextjsAppPaths.standaloneAppDir + "/", ""));
	workerContents = workerContents.replace(
		/function loadManifest\((.+?), .+?\) {/,
		`$&
    ${manifestJsons
			.map(
				(manifestJson) => `
          if ($1.endsWith("${manifestJson}")) {
            return ${readFileSync(
							`${nextjsAppPaths.standaloneAppDir}/${manifestJson}`,
							"utf-8"
						)};
          }
        `
			)
			.join("\n")}
    throw new Error("Unknown loadManifest: " + $1);
    `
	);

	// Next.js tries to instantiate an https agent, so here we replace that with a simple http one (which we support)
	// source: https://github.com/vercel/next.js/blob/aa90fe9bb/packages/next/src/server/setup-http-agent-env.ts#L20
	workerContents = workerContents.replace(
		'var _https = require("https");',
		'var _https = require("http");'
	);

	// This solves the fact that the workerd URL parsing is not compatible with the node.js one
	// VERY IMPORTANT: this required the following dependency to be part of the application!!!! (this is very bad!!!)
	//    "node-url": "npm:url@^0.11.4"
	// Hopefully this should not be necessary after this unenv PR lands: https://github.com/unjs/unenv/pull/292
	workerContents = workerContents.replace(
		/ ([a-zA-Z0-9_]+) = require\("url"\);/g,
		` $1 = require("url");
      const nodeUrl = require("node-url");
      $1.parse = nodeUrl.parse.bind(nodeUrl);
      $1.format = nodeUrl.format.bind(nodeUrl);
      $1.pathToFileURL = (path) => {
        console.log("url.pathToFileURL", path);
        return new URL("file://" + path);
      }
    `
	);

	// The following avoid various Next.js specific files `require`d at runtime since we can just read
	// and inline their content during build time
	const pagesManifestFile = `${nextjsAppPaths.standaloneAppServerDir}/pages-manifest.json`;
	const appPathsManifestFile = `${nextjsAppPaths.standaloneAppServerDir}/app-paths-manifest.json`;

	const pagesManifestFiles = existsSync(pagesManifestFile)
		? Object.values(JSON.parse(readFileSync(pagesManifestFile, "utf-8"))).map(
				(file) => ".next/server/" + file
			)
		: [];
	const appPathsManifestFiles = existsSync(appPathsManifestFile)
		? Object.values(
				JSON.parse(readFileSync(appPathsManifestFile, "utf-8"))
			).map((file) => ".next/server/" + file)
		: [];
	const allManifestFiles = pagesManifestFiles.concat(appPathsManifestFiles);

	const htmlPages = allManifestFiles.filter((file) => file.endsWith(".html"));
	const pageModules = allManifestFiles.filter((file) => file.endsWith(".js"));

	workerContents = workerContents.replace(
		/const pagePath = getPagePath\(.+?\);/,
		`$&
    ${htmlPages
			.map(
				(htmlPage) => `
          if (pagePath.endsWith("${htmlPage}")) {
            return ${JSON.stringify(
							readFileSync(
								`${nextjsAppPaths.standaloneAppDir}/${htmlPage}`,
								"utf-8"
							)
						)};
          }
        `
			)
			.join("\n")}
    ${pageModules
			.map(
				(module) => `
          if (pagePath.endsWith("${module}")) {
            return require("${nextjsAppPaths.standaloneAppDir}/${module}");
          }
        `
			)
			.join("\n")}
    throw new Error("Unknown pagePath: " + pagePath);
    `
	);

	await writeFile(workerOutputFile, workerContents);
}
