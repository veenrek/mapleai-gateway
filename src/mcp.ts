import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../packages/mapleai-mcp/src/server.js';

await createServer().connect(new StdioServerTransport());
