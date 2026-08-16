import { McpServer } from "@modelcontextprotocol/server";
import type { TasksClient } from "./google/client.js";
import { registerListTools } from "./tools/lists.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerBulkTools } from "./tools/bulk.js";

export const SERVER_NAME = "google-tasks-mcp";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Manage the user's Google Tasks (the ones that appear on Google Calendar).
Google Tasks stores DATE-ONLY due dates: pass \`due\` as YYYY-MM-DD and it
shows as an all-day item on that date; there is no time of day.
Typical flow: list_tasklists once to learn list ids/titles, list_tasks to see
what already exists (avoid duplicates), then create_task for one item or
create_tasks for several (it is idempotent on title+due by default).
Task \`title\` is what shows on the calendar; put details in \`notes\`.
Lists may be referenced by id or by title.`;

/**
 * Build a fully configured server instance bound to a Tasks client.
 * Called once per connection (stdio) or per request (stateless HTTP).
 */
export function createServer(client: TasksClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerListTools(server, client);
  registerTaskTools(server, client);
  registerBulkTools(server, client);
  return server;
}
