/* eslint-disable @typescript-eslint/no-var-requires */
import path from 'path';
import { Options as ProxyOptions } from 'http-proxy-middleware'

export type ConfigFile = {
    loader?: Record<string, string>;
    env?: Record<string, string>;
    proxy?: Record<string, ProxyOptions>;
}

const getConfigFromPath = (dir: string): ConfigFile | undefined => {
    const configPath = path.resolve(dir, 'esbuild.config.js');
    try {
        return require(configPath) as ConfigFile;
    } catch (ex) {
      const err = ex as {
        code: string;
        message: string;
      };
      console.log(err);
      process.exit(0)

      const configNotFound = err.code === 'MODULE_NOT_FOUND' 
        && err.message.lastIndexOf('esbuild.config.js') !== -1;
        
      if (!configNotFound) {
        throw ex;
      }
    }
}

export default getConfigFromPath;