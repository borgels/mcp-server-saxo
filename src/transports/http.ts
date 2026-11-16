import { ConfigError } from '../config-env.js';
import { SaxoClient } from '../saxo/client.js';
import { configWarnings, getHttpConfig, type HttpConfig } from './http-helpers.js';
import { startHttpServer } from './http-server.js';

function fail(message: string): never {
  console.error(`Saxo MCP HTTP server not started: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  let config: HttpConfig;
  try {
    config = getHttpConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(error.message);
    }
    throw error;
  }

  try {
    // Validate the Saxo client configuration (base URL, timeouts) once at
    // startup instead of on the first request.
    new SaxoClient();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  for (const warning of configWarnings(config)) {
    console.error(warning);
  }
  if (!config.httpToken) {
    console.error(
      'WARNING: MCP_HTTP_TOKEN is not set: any process that can reach this host:port can invoke Saxo write tools. ' +
        'Set MCP_HTTP_TOKEN to require a bearer token, especially if SAXO_ENABLE_LIVE_TRADING=true.',
    );
  }

  const running = await startHttpServer(config);
  console.error(`Saxo MCP HTTP server listening on http://${config.host}:${running.port}/mcp`);

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down`);
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
