/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import globalsPolyfills from '@esbuild-plugins/node-globals-polyfill'
import { createProxyMiddleware } from 'http-proxy-middleware'
import * as esbuild from "esbuild";
import chalk from "chalk";
import * as express from "express";
import ws from "express-ws";
import * as fs from "fs/promises";
import * as http from "http";
import * as path from "path";
import * as tmp from "tmp";
import isCi from "is-ci";
import memoize from "memoize-one";

import * as paths from "../config/paths";
import getClientEnvironment, {
  ClientEnvironment,
} from "../config/get-client-environment";

import cssModulesPlugin from "../plugins/css-modules";
import svgrPlugin from "../plugins/svgr";
import incrementalCompilePlugin from "../plugins/incremental-compile";
import incrementalReporterPlugin from "../plugins/incremental-reporter";
import websocketReloadPlugin from "../plugins/ws-reload";

import choosePort from "../utils/choose-port";
import openBrowser from "react-dev-utils/openBrowser";
import * as logger from "../utils/logger";
import prepareUrls, { InstructionURLS } from "../config/urls";
import { createIndex } from "../api";
import { formatError } from "../utils/format-error";
import getConfigFromPath, { ConfigFile } from '../config/file-config';

class DevServer {
  private express: express.Express;
  private server?: http.Server;
  private outdir: string;
  private started = false;

  private env: ClientEnvironment;
  private protocol: "https" | "http";

  private ws: ws.Instance;

  private config: ConfigFile = {
    loader: {},
    env: {},
    proxy: {}
  }

  constructor() {
    
    
    this.config = {
      ...getConfigFromPath(paths.appPath)
    };

    this.env = getClientEnvironment(paths.publicUrlOrPath.slice(0, -1), this.config.env);
    this.protocol = process.env.HTTPS === "true" ? "https" : "http";
    this.outdir = tmp.dirSync().name;
    this.express = express.default();
    this.ws = ws(this.express);

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    this.express.get("/", this.handleIndex);
    this.express.use(express.static(this.outdir));
    this.express.use(express.static(paths.appPublic));
    
    // https://webpack.js.org/configuration/dev-server/#devserverproxy
    Object.entries(this.config.proxy ?? {}).forEach(([path, options]) => {
      this.express.use(path, createProxyMiddleware({
        ...options,
        logProvider: () => ({
          log: logger.log,
          debug: logger.log,
          error: logger.error,
          info: logger.log,
          warn: logger.warn,
        })
      }));
    });
    // https://webpack.js.org/configuration/dev-server/#devserverhistoryapifallback
    // By default return the index file to allow pushState https://developer.mozilla.org/es/docs/Web/API/History/pushState
    const historyApiFallback = process.argv.includes('--pushState')
    if (historyApiFallback) {
      this.express.use(this.handleIndex);
    }

    this.ws.app.ws("/_ws", (ws, req) => {
      logger.debug("Connected");
    });
  }

  _host = memoize(() => {
    if (process.env.HOST) {
      logger.log(
        chalk.cyan(
          `Attempting to bind to HOST environment variable: ${chalk.yellow(
            chalk.bold(process.env.HOST)
          )}`
        )
      );
      logger.log(
        `If this was unintentional, check that you haven't mistakenly set it in your shell.`
      );
      logger.log(
        `Learn more here: ${chalk.yellow("https://cra.link/advanced-config")}`
      );
      logger.log();
    }
    return process.env.HOST || "0.0.0.0";
  });

  get host() {
    // wrap memoized version to prevent multiple logging calls.
    return this._host();
  }

  urls: () => Promise<InstructionURLS> = memoize(async () => {
    return prepareUrls(
      this.protocol,
      this.host,
      await this.port(),
      paths.publicUrlOrPath.slice(0, -1)
    );
  });

  private port: () => Promise<number> = memoize(async () => {
    const port = await choosePort(
      this.host,
      parseInt(process.env.PORT || "3000", 0)
    );
    if (port) {
      return port;
    } else {
      throw new Error(`Could not identify port to run against`);
    }
  });

  async start(): Promise<DevServer> {
    const port = await this.port();

    // force clearing the terminal when we start a dev server process
    // unless we're in CI because we'll want to keep all logs
    logger.clear();
    logger.debug(`Using ${this.outdir}`);
    logger.log(chalk.cyan("Starting the development server...\n"));

    // Start the esbuild before we startup the server
    await this.esbuildServer();
    await this.hostRuntime();

    return new Promise<DevServer>((resolve, reject) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        this.server = this.express.listen(port, this.host, async () => {
          const { localUrlForBrowser } = (await this.urls());
          openBrowser(localUrlForBrowser);
          this.started = true;
          resolve(this);
        });
      } catch (err) {
        logger.error(err);
        reject(err);
      }
    });
  }

  shudown = async () => {
    if (this.started) {
      this.server?.close();
    }
    const esbuildServer = await this.esbuildServer();
    esbuildServer && esbuildServer.stop && esbuildServer.stop();
  };

  private hostRuntime = memoize(async () => {
    const runtimeDir = path.join(__dirname, "..", "runtime");

    const runtimeDirFiles = await fs.readdir(runtimeDir);
    const indexFiles = runtimeDirFiles.filter((p) => p.startsWith("index"));
    if (indexFiles.length !== 1) {
      throw new Error(`Found multiple possible entry files`);
    }
    const entryPoint = indexFiles[0];

    try {
      return await esbuild.build({
        entryPoints: [path.join(runtimeDir, entryPoint)],
        bundle: true,
        resolveExtensions: paths.moduleFileExtensions.map(
          (extension) => `.${extension}`
        ),
        sourcemap: true,
        absWorkingDir: paths.appPath,
        format: "esm",
        target: "es2015",
        logLevel: "silent",
        color: !isCi,
        define: {
          global: 'window',
          ...this.env.stringified,
        },
        watch: true,
        write: true,
        plugins: [
          websocketReloadPlugin("runtime", this.ws.getWss()),
          incrementalReporterPlugin(),
        ],
        outbase: runtimeDir,
        outdir: path.join(this.outdir, "_runtime"),
        publicPath: (await this.urls()).localUrlForBrowser,
      });
    } catch (e) {
      const result = e as esbuild.BuildFailure;
      logger.log(chalk.red("Failed to compile runtime.\n"));
      const logs = result.errors.concat(result.warnings).map(async (m) => {
        logger.log(await formatError(m));
      });

      await Promise.all(logs);

      throw new Error(`Failed to compile runtime`);
    }
  });

  private runEsbuild = async (watch: boolean) => {
    const plugins: esbuild.Plugin[] = [
      cssModulesPlugin,
      svgrPlugin(),
      incrementalReporterPlugin(),
      globalsPolyfills({
        buffer: true
      })
    ];
    let resolveIntialBuild;
    if (watch) {
      const { plugin, initialBuildPromise } = incrementalCompilePlugin(
        await this.urls()
      );
      resolveIntialBuild = initialBuildPromise;
      plugins.push(plugin);
      plugins.push(websocketReloadPlugin("app", this.ws.getWss()));
    } else {
      resolveIntialBuild = Promise.resolve();
    }

    const result = await esbuild.build({
      entryPoints: [paths.appIndexJs],
      plugins,
      bundle: true,
      watch,
      resolveExtensions: paths.moduleFileExtensions.map(
        (extension) => `.${extension}`
      ),
      sourcemap: true,
      target: "es2015",
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
        ...this.config.loader
      },
      logLevel: "silent",
      absWorkingDir: paths.appPath,
      format: "esm",
      color: !isCi,
      define: {
        global: 'window',
        ...this.env.stringified,
      },
      metafile: true,
      incremental: watch,
      // if we're not watching then we don't actually care about any output
      // for now - we just want to make sure the build works initially.
      write: watch,
      tsconfig: paths.appTsConfig,
      minify: false,
      outbase: "src",
      outdir: this.outdir,
      publicPath: (await this.urls()).localUrlForBrowser,
      nodePaths: paths.NODE_PATH,
    });

    // wait for the initial build to complete
    await resolveIntialBuild;

    // return the result of the build
    return result;
  };

  private esbuildServer: () => Promise<esbuild.BuildResult> = memoize(
    async () => {
      try {
        await this.runEsbuild(false);
      } catch (e) {
        const result = e as esbuild.BuildFailure;
        logger.log(chalk.red("Failed to compile.\n"));
        const logs = result.errors.map(async (m) => {
          logger.log(await formatError(m));
        });

        await Promise.all(logs);

        throw new Error(`Failed to compile`);
      }

      // if the non-incremental succeeds then
      // we start a watching server
      return this.runEsbuild(true);
    }
  );

  handleIndex = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200);
    res.end(await createIndex(this.env.raw, true));
  };
}

new DevServer()
  .start()
  .then((server) => {
    ["SIGINT", "SIGTERM"].forEach((sig) => {
      process.on(sig, () => {
        void server.shudown();
      });
    });

    if (!isCi) {
      // Gracefully exit when stdin ends
      process.stdin.on("end", () => {
        void server.shudown();
      });
    }
  })
  .catch(() => {
    process.exit(1);
  });
