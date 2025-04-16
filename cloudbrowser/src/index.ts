#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  CallToolResult,
  TextContent,
  ImageContent,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import puppeteer, { Browser, Page } from "puppeteer-core";

// Environment variables configuration
const requiredEnvVars = {
  SESSION_ID: process.env.SESSION_ID,
  API_KEY: process.env.API_KEY,
};

// Validate required environment variables
Object.entries(requiredEnvVars).forEach(([name, value]) => {
  //if (!value) throw new Error(`${name} environment variable is required`);
});

// 2. Global State
const browsers = new Map<string, { browser: Browser; page: Page }>();
const screenshots = new Map<string, string>();

// Global state variable for the default browser session
let defaultBrowserSession: { browser: Browser; page: Page } | null = null;
const sessionId = "default"; // Using a consistent session ID for the default session

// Ensure browser session is initialized and valid
async function ensureBrowserSession(): Promise<{
  browser: Browser;
  page: Page;
}> {
  try {
    // If no session exists, create one
    if (!defaultBrowserSession) {
      defaultBrowserSession = await createNewBrowserSession(process.env.SESSION_ID!, process.env.API_KEY!);
      return defaultBrowserSession;
    }

    await defaultBrowserSession.page.evaluate(() => document.title);
    return defaultBrowserSession;

  } catch (error) {

    throw error;
  }
}

// 3. Helper Functions
async function getBrowserUrl(sessionId: string, apiKey: string) {
  try {
    // 发起请求
    const response = await fetch(
      `http://localhost:8080/v2/cloudbrowser/api/session/start?apiKey=${apiKey}&sessionId=${sessionId}`,
      {
        method: "POST", // 根据实际情况可能需要调整请求方法
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}), // 如果需要传递数据，可以在这里添加
      }
    );

    // 检查响应状态
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // 解析响应体
    const data = await response.json();

    // 提取 browserUrl
    if (data.code === 200 && data.data && data.data.browserUrl) {
      return data.data.browserUrl;
    } else {
      throw new Error(`Failed to get browserUrl. Response: ${JSON.stringify(data)}`);
    }
  } catch (error) {
    console.error('Error fetching browserUrl:', error);
    throw error;
  }
}

async function createNewBrowserSession(sessionId: string, apiKey: string) {
  // 通过 fetch 获取 browserUrl
  const connectUrl = await getBrowserUrl(sessionId, apiKey)

  const browser = await puppeteer.connect({
    browserWSEndpoint: connectUrl,
  });

  const page = (await browser.pages())[0];
  browsers.set(sessionId, { browser, page });

  return { browser, page };
}

// 4. Tool Definitions
const TOOLS: Tool[] = [
  {
    name: "cloudbrowser_navigate",
    description: "Navigate to a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "cloudbrowser_evaluate",
    description: "Evaluate JavaScript in the browser",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string" },
      },
      required: ["script"],
    },
  },
  {
    name: "cloudbrowser_get_current_url",
    description: "Retrieve the current URL of the browser page",
    inputSchema: {
      type: "object",
      properties: {
      },
    },
  },
  {
    name: "cloudbrowser_screenshot",
    description: "Takes a screenshot of the current page. Use this tool to learn where you are on the page when controlling the browser with Stagehand. Only use this tool when the other tools are not sufficient to get the information you need.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the screenshot",
        },
      },
    },
  },
  {
    name: "cloudbrowser_click",
    description: "Click an element on the page",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for element to click",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "cloudbrowser_fill",
    description: "Fill out an input field",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for input field",
        },
        value: { type: "string", description: "Value to fill" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "cloudbrowser_get_text",
    description: "Extract all text content from the current page",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// 5. Tool Handler Implementation
async function handleToolCall(
  name: string,
  args: any
): Promise<CallToolResult> {
  try {
    let session: { browser: Browser; page: Page } | undefined;

    // For tools that don't need a session, skip session check
    if (!["cloudbrowser_create_session"].includes(name)) {
        // Use or create the default session
        session = await ensureBrowserSession();
    }

    //console.info(`Handling tool call: ${name}`, args);
    switch (name) {
      case "cloudbrowser_navigate":
        await session!.page.goto(args.url);
        return {
          content: [
            {
              type: "text",
              text: `Navigated to ${args.url}`,
            },
          ],
          isError: false,
        };

      case "cloudbrowser_evaluate":
        try {
          const result = await session!.page.evaluate(args.script);
          return {
            content: [
              {
                type: "text",
                text: `Evaluated script: ${JSON.stringify(result)}`,
              },
            ],
            isError: false,
          }
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to Evaluated script: ${args.script}: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }


      case "cloudbrowser_get_current_url":
        const currentUrl = await session!.page.url();
        return {
          content: [
            {
              type: "text",
              text: `Current URL: ${currentUrl}`,
            },
          ],
          isError: false,
        };

      case "cloudbrowser_screenshot": {

        const screenshot = await session!.page.screenshot({
          encoding: "base64",
          fullPage: false,

        });

        if (!screenshot) {
          return {
            content: [
              {
                type: "text",
                text: "Screenshot failed",
              },
            ],
            isError: true,
          };
        }

        screenshots.set(args.name, screenshot as string);
        server.notification({
          method: "notifications/resources/list_changed",
        });

        return {
          content: [
            {
              type: "text",
              text: `Screenshot taken`,
            } as TextContent,
            {
              type: "image",
              data: screenshot,
              mimeType: "image/png",
            } as ImageContent,
          ],
          isError: false,
        };
      }

      case "cloudbrowser_click":
        try {
          await session!.page.click(args.selector);
          return {
            content: [
              {
                type: "text",
                text: `Clicked: ${args.selector}`,
              },
            ],
            isError: false,
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to click ${args.selector}: ${(error as Error).message
                  }`,
              },
            ],
            isError: true,
          };
        }

      case "cloudbrowser_fill":
        try {
          await session!.page.waitForSelector(args.selector);
          await session!.page.type(args.selector, args.value);
          return {

            content: [
              {
                type: "text",
                text: `Filled ${args.selector} with: ${args.value}`,
              },
            ],
            isError: false,

          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to fill ${args.selector}: ${(error as Error).message
                  }`,
              },
            ],
            isError: true,
          };
        }

      case "cloudbrowser_get_text": {
        try {
          const bodyText = await session!.page.evaluate(() => document.body.innerText);
          const content = bodyText
            .split('\n')
            .map(line => line.trim())
            .filter(line => {
              if (!line) return false;

              if (
                (line.includes('{') && line.includes('}')) ||
                line.includes('@keyframes') ||                         // Remove CSS animations
                line.match(/^\.[a-zA-Z0-9_-]+\s*{/) ||               // Remove CSS lines starting with .className {
                line.match(/^[a-zA-Z-]+:[a-zA-Z0-9%\s\(\)\.,-]+;$/)  // Remove lines like "color: blue;" or "margin: 10px;"
              ) {
                return false;
              }
              return true;
            })
            .map(line => {
              return line.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
                String.fromCharCode(parseInt(hex, 16))
              );
            });

          return {
            content: [
              {
                type: "text",
                text: `Extracted content:\n${content.join('\n')}`,
              },
            ],
            isError: false,
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to extract content: ${(error as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `Failed to handle tool call: ${errorMsg}`
    );
    return {
      content: [
        {
          type: "text",
          text: `Failed to handle tool call: ${errorMsg}`,
        },
      ],
      isError: true,
    };
  }
}

// 6. Server Setup and Configuration
const server = new Server(
  {
    name: "example-servers/browserbase",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// 7. Request Handlers
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    ...Array.from(screenshots.keys()).map((name) => ({
      uri: `screenshot://${name}`,
      mimeType: "image/png",
      name: `Screenshot: ${name}`,
    })),
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri.toString();


  if (uri.startsWith("screenshot://")) {
    const name = uri.split("://")[1];
    const screenshot = screenshots.get(name);
    if (screenshot) {
      return {
        contents: [
          {
            uri,
            mimeType: "image/png",
            blob: screenshot,
          },
        ],
      };
    }
  }

  throw new Error(`Resource not found: ${uri}`);
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  handleToolCall(request.params.name, request.params.arguments ?? {})
);

// 8. Server Initialization
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch(console.error);
