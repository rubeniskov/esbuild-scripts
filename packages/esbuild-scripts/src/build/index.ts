/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import * as esbuild from "esbuild";
import isCi from "is-ci";
import chalk from "chalk";
import fs from "fs-extra";
import * as minimize from "html-minifier-terser";
import * as path from "path";
import getClientEnvironment from "../config/get-client-environment";

import * as paths from "../config/paths";
import * as logger from "../utils/logger";
import { formatError } from "../utils/format-error";

import cssModulesPlugin from "../plugins/css-modules";
import svgrPlugin from "../plugins/svgr";
import globalsPolyfills from '@esbuild-plugins/node-globals-polyfill'
import checkRequiredFiles from "../utils/check-required-files";
import printHostingInstructions from "./print-hosting-instructions";
import { createIndex } from "../api";

const plugins: esbuild.Plugin[] = [cssModulesPlugin, svgrPlugin(), globalsPolyfills({
  buffer: true
})];

void (async () => {

  let config: {
    loader: Record<string, string>;
    env: Record<string, string>;
  } = {
    loader: {},
    env: {}
  };

  if (checkRequiredFiles([paths.appHtml, paths.appIndexJs])) {
    process.exit(1);
  }

  const configPath = path.resolve(paths.appPath, 'esbuild.config.js');
  try {
    config = require(configPath);
  } catch (error) {}

  logger.log("Creating an optimized production build...");

  const env = getClientEnvironment(paths.publicUrlOrPath.slice(0, -1), config.env);

  await fs.emptyDir(paths.appBuild);

  await fs.copy(paths.appPublic, paths.appBuild, {
    dereference: true,
    filter: (file) => file !== paths.appHtml,
  });

  const html = await createIndex(env.raw, false);
  await fs.writeFile(
    path.join(paths.appBuild, "index.html"),
    minimize.minify(html, {
      html5: true,
      collapseBooleanAttributes: true,
      collapseWhitespace: true,
      collapseInlineTagWhitespace: true,
      decodeEntities: true,
      minifyCSS: true,
      minifyJS: true,
      removeAttributeQuotes: true,
      removeComments: true,
      removeTagWhitespace: true,
    })
  );

  try {
    await esbuild.build({
      entryPoints: [paths.appIndexJs],
      plugins,
      bundle: true,
      watch: false,
      resolveExtensions: paths.moduleFileExtensions.map(
        (extension) => `.${extension}`
      ),
      sourcemap: true,
      loader: {
        // loaders for images which are supported as files
        ".avif": "file",
        ".bmp": "file",
        ".gif": "file",
        ".jpg": "file",
        ".jpeg": "file",
        ".png": "file",
        ".webp": "file",

        // enable JSX in js files
        ".js": "jsx",
        ...config.loader
      },
      logLevel: "silent",
      target: "es2015",
      absWorkingDir: paths.appPath,
      format: "esm",
      color: !isCi,
      define: {
        global: 'window',
        ...getClientEnvironment(paths.publicUrlOrPath).stringified,
      },
      metafile: true,
      tsconfig: paths.appTsConfig,
      minify: true,
      outbase: "src",
      outdir: paths.appBuild,
      publicPath: paths.publicUrlOrPath,
      nodePaths: paths.NODE_PATH,
    });

    const buildFolder = path.relative(process.cwd(), paths.appBuild);
    const useYarn = fs.existsSync(paths.yarnLockFile);

    printHostingInstructions(
      fs.readJSON(paths.appPackageJson),
      paths.publicUrlOrPath,
      paths.publicUrlOrPath,
      buildFolder,
      useYarn
    );

    process.exit(0);
  } catch (e) {
    const result = e as esbuild.BuildFailure;
    logger.log(chalk.red("Failed to compile.\n"));
    const logs = result.errors.map(async (m) => {
      logger.log(await formatError(m));
    });

    await Promise.all(logs);

    process.exit(1);
  }
})();
