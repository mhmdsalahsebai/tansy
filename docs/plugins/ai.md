# AI plugin (`@tansy/ai`)

## 1. Two things, one layer

"AI in the CMS" covers two different callers:

| Who | Where | What it is |
|---|---|---|
| An outside agent: Claude Desktop, Claude Code, Cursor, ChatGPT and others | `POST /api/mcp`, with an API key | Core, like REST. MCP was already there. It now serves every tool below |
| An editor in the dashboard | The assistant, **Fill with AI** on a record, **✦ AI** by a text field | This plugin, on the Vercel AI SDK |

Both use the same **agent tools** (C18). A tool is something an agent can do in the CMS, run as whoever is asking:

| Tool | From | Writes |
|---|---|---|
| `list_collections`, `describe_collection`, `list_records`, `get_record` | Core | No |
| `create_record`, `update_record`, `delete_record` | Core | Yes |
| `lms_create_course` (course, sections and lessons in one call), `lms_outline` | LMS | `lms_create_course` |
| `shop_create_product` (product and its variants) | Shop | Yes |

Any plugin adds its own with `tools` in its manifest ([Extending Tansy](../EXTENDING.md#agent-tools)), and both MCP and the assistant get them. `describe_collection` gives each field's JSON Schema and the blocks a stream accepts, so an agent can work with collections an owner made in the dashboard as well as with plugins' own. Writes through tools take rich text as Markdown and fill in blocks' ids and versions.

## 2. Providers

The plugin has no model SDK of its own. A site installs one adapter per provider it may use, as Payments and Email do:

| Package | Provider | Key (environment variable) |
|---|---|---|
| `@tansy/ai-openai` | OpenAI | `OPENAI_API_KEY` |
| `@tansy/ai-anthropic` | Anthropic | `ANTHROPIC_API_KEY` |
| `@tansy/ai-google` | Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `@tansy/ai-gateway` | Vercel AI Gateway: models from every major provider with one key, as `provider/model` | `AI_GATEWAY_API_KEY` |
| `@tansy/ai-mistral` | Mistral | `MISTRAL_API_KEY` |
| `@tansy/ai-xai` | xAI Grok | `XAI_API_KEY` |
| `@tansy/ai-groq` | Groq | `GROQ_API_KEY` |
| `@tansy/ai-deepseek` | DeepSeek | `DEEPSEEK_API_KEY` |
| `@tansy/ai-openrouter` | OpenRouter: hundreds of models with one key, as `vendor/model`. Its default, `openrouter/free`, picks a free model that can call tools | `OPENROUTER_API_KEY` |
| `@tansy/ai-opencode` | OpenCode's pay-as-you-go models (Claude, GPT, Gemini, Grok, GLM, Kimi, Qwen, DeepSeek…) with one key from opencode.ai/console. Each family goes through its own API: Claude through Anthropic's, GPT and Grok through OpenAI's Responses, Gemini through Google's, the rest through OpenAI's chat API. Its free models answer only the OpenCode app, so they aren't offered | `OPENCODE_API_KEY` |
| `@tansy/ai-commandcode` | Command Code's provider API (Claude, GPT, Gemini, Grok, DeepSeek, Kimi, GLM, Qwen, MiniMax…) with one key from commandcode.ai/settings/keys, on any plan but Go. Claude goes through Anthropic's Messages API, which is the only route Command Code serves it on, and the rest through OpenAI's chat API. Its decision models, served only on `/systemone`, aren't offered | `COMMANDCODE_API_KEY` |
| `@tansy/ai-openai-compatible` | Any server with OpenAI's chat API: Ollama, LM Studio, vLLM, OpenRouter, Together, Fireworks, a self-hosted model | `OPENAI_COMPATIBLE_API_KEY`, optional |

```ts
// tansy.config.ts
import { ai } from "@tansy/ai";
import { anthropic } from "@tansy/ai-anthropic";
import { openaiCompatible } from "@tansy/ai-openai-compatible";

plugins: [ai({ providers: [anthropic(), openaiCompatible()] })]
```

Then, under **AI → Settings**, choose the provider, paste its key or set its environment variable, and save. The model settings then list the models that key can use, read from the provider's OpenAI-style `/models` endpoint (OpenAI, OpenRouter, OpenCode, Command Code, Groq, Mistral, xAI, DeepSeek and any OpenAI-compatible server), and still take any id typed in. OpenRouter lists its free models first, and only models that can call tools. When a provider refuses a request, the assistant shows the provider's own reason, such as a used-up quota or an unknown model, with anything that looks like a key hidden. An adapter offers its models with an optional `models(settings)`, and `openAiModels(baseUrl, key)` from `@tansy/ai/provider` covers any OpenAI-style API. Any other AI SDK provider (Bedrock, Azure, Cohere, a community one) is a few lines with `defineAiProvider` from `@tansy/ai/provider`:

```ts
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { defineAiProvider, str } from "@tansy/ai/provider";

export const bedrock = () => defineAiProvider({
  id: "bedrock",
  label: "Amazon Bedrock",
  defaultModel: "anthropic.claude-sonnet-5-5",
  settings: () => [
    { name: "bedrockRegion", type: "text", default: "us-east-1", label: "Region" },
    { name: "bedrockAccessKeyId", type: "secret", env: "AWS_ACCESS_KEY_ID", label: "Access key id" },
    { name: "bedrockSecretAccessKey", type: "secret", env: "AWS_SECRET_ACCESS_KEY", label: "Secret access key" },
  ],
  ready: (s) => Boolean(str(s.bedrockAccessKeyId) && str(s.bedrockSecretAccessKey)),
  model: (s, id) => createAmazonBedrock({ region: str(s.bedrockRegion), accessKeyId: str(s.bedrockAccessKeyId), secretAccessKey: str(s.bedrockSecretAccessKey) })(id),
});
```

## 3. What it adds

| Part | What |
|---|---|
| Settings | Provider, model, a cheaper model for writing fields, the provider and model that draw pictures in the chat, whether people choose the model and thinking in the chat, the default thinking, site guidance (tone, audience) added to every prompt, the most tool calls per answer, the longest answer, then each adapter's keys (`secret` settings) |
| Permission | `ext.ai:use`. Owners grant it to roles under **Roles**. It only opens the AI. What the AI can then do is what both the person and the AI's role may do |
| Role | **AI assistant** (`ai-assistant`), created once at startup and then the owner's to change under **Roles** like any other. It reads and drafts content (`collection:read`, `record:list`, `read`, `create`, `update`, `file:list`, `file:read`, `locale:edit`) and can't delete or touch schemas, users, settings, roles or keys. Nobody holds it: it only limits the AI. **Role the AI acts with** chooses another, and **Admins choose the role in the chat** lets people who hold `user:set-role`, admins by default, pick one for a chat. Nobody else can: the chat refuses a role from them with 403, and the menu isn't shown. A workflow's **Creates records with the role** follows the same rule: saving a workflow with a different role needs `user:set-role`. Choosing Superadmin gives the AI the person's whole access |
| **AI → Assistant** | A chat that reads and writes the CMS through every tool the person may run. Each write shows as a card with **Approve** and **Don't**, and nothing is created, changed or deleted before Approve. Each chat is saved as its answers end. A side panel lists them by day, with a search, to open again here or on another device. The composer picks the model, from what the provider lists or any id typed in, each with its brand icon from @lobehub/icons, and how long it thinks (Auto, Off, Low, Medium, High, as the AI SDK's `reasoning`), and remembers both in this browser. For someone holding `user:set-role` it also picks the role for the chat, which every visit starts on the site's. The model's thinking shows folded above its answer. Suggestions on an empty chat send only complete requests; the rest put the start of one in the box for the person to finish. **Files**: the paperclip, a drop or a paste attaches up to five files of up to 8 MB to a message: pictures, PDFs, sound and video when the chosen model reads them, as its provider reports or its name suggests, and text, Markdown, CSV and JSON for any model, sent as text. **Pictures**: with **Model for pictures** set, the assistant gets a `generate_image` tool and draws when asked; the picture shows in the chat with **Download** and **Add to files**, which uploads it to the site's files as the person |
| **Fill with AI** | A panel under each record form (C19). Describe the record, and the fields a model can fill sensibly (text, numbers, choices, dates, rich text) fill in for review. Files, references, blocks and prices are left to the person. Nothing is saved |
| **✦ AI** by text fields | Write, improve, shorten, expand, fix or translate one text or rich-text field, with an optional instruction. The result lands in the form, unsaved |
| `GET /api/ext/ai/status` | `ext.ai:use`. Whether a provider is set up, and which model |
| `POST /api/ext/ai/chat` | `ext.ai:use`, audited as `ai.chat` with the model, role and thinking. The AI SDK's UI message stream. Takes an optional `model` and `reasoning`, used only while the settings let people choose, and `role`, which also needs `user:set-role` and is otherwise refused with 403. Refused when the role no longer exists |
| `GET /api/ext/ai/roles` | `ext.ai:use`, and `user:set-role` or `setting:update`. The site's roles, by name, label and description, for the chat's role menu and the role setting |
| `GET /api/ext/ai/models?provider=` | `setting:update`, as it uses the saved key. The provider's models, for the model settings |
| `GET /api/ext/ai/chat/models` | `ext.ai:use`. The provider's models, for the chat's model menu: ids and names only, listed at most every ten minutes. Empty when people may not choose |
| `GET /api/ext/ai/chat/capabilities?model=` | `ext.ai:use`. The file types the chat's model takes, the size limit, and whether the chat draws |
| `GET /api/ext/ai/image-models?provider=&imageProvider=` | `setting:update`. The models that draw, for the picture setting |
| `POST /api/ext/ai/attachments?name=` | `ext.ai:use`, audited as `ai.attachment.upload` with the type and size. The body is the file. Only the types above, up to 8 MB |
| `GET /api/ext/ai/attachments/:id` | `ext.ai:use`. One of the caller's own attachments or drawn pictures |
| `DELETE /api/ext/ai/attachments/:id` | `ext.ai:use`, audited as `ai.attachment.delete` |
| `GET /api/ext/ai/chats` | `ext.ai:use`. The caller's own saved chats: id, title, last used |
| `GET /api/ext/ai/chats/:id` | `ext.ai:use`. One of the caller's chats, with its messages |
| `DELETE /api/ext/ai/chats/:id` | `ext.ai:use`, audited as `ai.chat.delete`. Deletes one of the caller's chats |
| `POST /api/ext/ai/fill` | `ext.ai:use`, audited as `ai.fill`. Values for a collection's fillable fields, from a prompt and the current values |
| `POST /api/ext/ai/write` | `ext.ai:use`, audited as `ai.write`. New text for one field |

## 4. Workflows

**AI → Workflows** runs a team of agents that writes records into one or more collections, such as a course with its sections and lessons, or a batch of articles. It is the orchestrator pattern of CrewAI, LangGraph and n8n's AI agents, built for content: a lead plans, writers draft, a judge scores, illustrators draw, and a person reviews before anything is saved.

| Part | What |
|---|---|
| **Brief** | The master prompt every agent works from, with `{{inputs}}` asked for at each run, such as the topic and the audience |
| **Team** | Agents, each a provider and model with a role, thinking and temperature. Any installed provider whose key is saved, so one workflow can mix Claude, GPT, Gemini and an OpenRouter image model. The model picker shows each model's provider and family icon (from [`@lobehub/icons`](https://github.com/lobehub/lobe-icons)) and what it can do |
| **Lead** (optional) | Reads the brief first and writes a style guide, each agent's own prompt for each step, and each judge's rubric. The run shows them under *The lead's plan* |
| **Steps** | Each writes records into a collection: exactly N, or between N and M as the content needs. A step under another runs once for each of its records, so sections are outlined per course and lessons per section, each knowing its parents and siblings. A step names the reference field linking each record to its parent, more links further up (a lesson's course), and a number field to fill with its position |
| **Writers** | One or more per step. *Take turns* shares records out between them; *Compete* has every writer draft each record and the judge keep the best; *Fallback* uses the first and hands over when it fails |
| **Judge** (optional) | Scores each draft from 1 to 10 against its rubric. A draft under the passing score goes back to its writer with the judge's notes, up to the number of revisions set, and the best draft is kept |
| **Pictures** | For each image field, agents that draw, a style and a shape. The first that succeeds is used |
| **Reliability** | Calls that fail with a timeout, a rate limit, a server error or an unreadable answer are tried again with doubling waits and jitter; a writer that keeps failing hands the record to the next one. How many tasks run at once is a setting |

A run works through its tasks in the background, a few at a time, saving after each, so the page can be closed. The run page shows each step's records as they're outlined, written and scored, the activity log, the model calls, tokens and pictures. A run survives a restart: it holds a lease while one server works on it, and a job checks every minute for runs nobody holds. Failed tasks can be tried again, and any record written again.

**Review, then create.** Nothing is saved as a record until a person reviews the run: they read each record, see its score and the judge's notes, leave out what they don't want, and press **Create records**. The browser uploads the pictures to the site's files as that person, then the records are created parents first, through the same `create_record` tool the assistant uses, as that person: their rules and validation apply, and each record is audited. Records are drafts unless the workflow says published. Creating is idempotent per record, so pressing it twice creates nothing twice.

**Models are checked against their tasks.** Each provider's model list now says what each model reads and writes, from the provider's own API where it says so: OpenRouter's `architecture` and `supported_parameters`, OpenCode's `modalities` and `capabilities`, the Vercel AI Gateway's `type` and `tags`, Google's `supportedGenerationMethods`, xAI's language and image model lists, Mistral's `capabilities`, Anthropic's model list. OpenAI, Groq, DeepSeek, Command Code and OpenAI-compatible servers list only ids, so their models' abilities come from their names (`gpt-image-*` draws, `o4-*` thinks), marked *From its name*. A model its provider says can't do its task (a text model asked to draw, an image model asked to write) can't be chosen, and a workflow using one won't run. A model the provider says nothing about runs with a warning. The assistant's model menus keep to models that chat and call tools.

**Pictures** come from an adapter's optional `imageModel(settings, id)` (OpenAI's GPT Image and DALL·E, xAI, Google's Imagen, the Gateway's image models, and OpenRouter and OpenAI-compatible servers through their chat API's image modality), or from a language model that answers with pictures, such as Gemini's image models. They're kept in the plugin's store, in pieces, until the records are created.

| Route | Access |
|---|---|
| `GET /api/ext/ai/workflows` | `ext.ai:workflows`. Workflows and recent runs |
| `GET /api/ext/ai/workflows/catalog` | `ext.ai:workflows`. Each provider, whether it's set up, and its models with what each can do. Never a key. The collections the caller can read |
| `GET /api/ext/ai/workflows/collections/:slug` | `ext.ai:workflows`. A collection's fields, as `describe_collection` gives them to the caller |
| `GET`, `PUT`, `DELETE /api/ext/ai/workflows/:id` | `ext.ai:workflows`, audited as `ai.workflow.save` (with the models) and `ai.workflow.delete` |
| `POST /api/ext/ai/workflows/:id/runs` | `ext.ai:workflows`, audited as `ai.workflow.run`, 10 a minute. Refused when a model can't do its task |
| `GET /api/ext/ai/runs/:id` | `ext.ai:workflows`. The run; with `?values=1`, its records as text for review |
| `GET /api/ext/ai/runs/:id/images/:image` | `ext.ai:workflows`. A picture, served only as an image type with `nosniff` |
| `POST /api/ext/ai/runs/:id/cancel`, `/retry`, `/items/:item/regenerate` | `ext.ai:workflows`, audited as `ai.workflow.cancel`, `ai.workflow.retry`, `ai.workflow.regenerate` |
| `POST /api/ext/ai/runs/:id/commit` | `ext.ai:workflows`, audited as `ai.workflow.commit`. Creates the records as the caller through `create_record` |
| `DELETE /api/ext/ai/runs/:id` | `ext.ai:workflows`, audited as `ai.workflow.run.delete` |

`ext.ai:workflows` is its own permission because a workflow chooses which paid models run and how many calls they make. It grants nothing in the content: creating records still needs the caller's own access.

## 5. Security

- **Within its role, as the person, never more.** Every tool goes through `context.tools.withRole(role)`, which keeps only what both the person and the role grant (a global grant on one side and a collection's on the other give the collection's), and runs it as the caller through `scopedRecords`. A role can only take access away, which is why anyone with `ext.ai:use` may pick one. Records still belong to the person, and each tool call's audit entry names the role: API rules, own-record grants, hidden fields and plugin hooks all apply, as over REST. The AI never gets `system.records`. API keys can't use the plugin's routes. Outside agents use MCP with a key, which is limited the same way.
- **Writes wait for a person.** Every tool with `write: true` needs an explicit Approve in the assistant (the AI SDK's `toolApproval`). Approvals are signed with a key derived from the auth secret, so a request can't carry an approval the server never asked for. This is what keeps text a model reads, such as a record's body saying "delete every post", from changing anything by itself. The system prompt also says so, but the approval is the control.
- **Fill and write never save.** They return values to the form, and the person saves as usual, through the usual validation.
- **What reaches the provider** is the conversation, the tool results (only what the person could read anyway, cut at 40,000 characters each) and, for fill and write, the record's current values. Owners choose the provider. The OpenAI-compatible server's address is a setting, so only people who may change settings choose where prompts go.
- **Saved chats** are in the plugin's store (the `PluginData` table, one JSON value per chat), under a key made from a hash of the person's id, so nobody can name, read or delete another person's chats, whatever their role. They hold what the person saw: their questions, the answers and the tool results. Each person keeps their 100 most recent chats, and a chat over 240 KB keeps its most recent messages. Removing the person's AI permission stops them reaching their chats; it doesn't delete them.
- **Attachments and drawn pictures** are kept like chats, in the plugin's store under a hash of the person's id, in pieces, and served only to their owner, with the type they were let in as, `nosniff` and a sandboxing CSP: never SVG or HTML. A message's file parts must point at the caller's own attachments; the server reads them from the store, so a request can never make it fetch an address. Files are data, as record text is: the system prompt says so. Each person keeps their 300 most recent, and deleting a chat deletes its files. Drawing isn't a write to the CMS, so it doesn't wait for Approve; **Add to files** is the person's own upload.
- **Keys** are `secret` settings (C14): encrypted, never sent to the dashboard, never audited. A provider's error messages go to the server log, not to the person.
- **Audit**: each route call is logged with the provider and model, and each tool call on its own (`tool.call` for reads, the tool's own action for writes), with `via: plugin:ai`, by tool and record id, never values.
- **Choosing the model** is on by default, and it costs what that model costs: owners who'd rather keep everyone on one model turn off **People choose the model in the chat**. The server then ignores a model a request names. It never sends the key to the browser.
- **Cost**: routes are rate limited per person, answers are capped by the settings, and tool calls per answer are capped. A workflow run makes at most 300 records, and its calls are counted on the run page.
- **Workflows** run in the background with no person behind them, so they never touch the content: they only call models and keep drafts in the plugin's store, from collection fields read as the person who started the run. Records are created only when a person presses **Create records**, as that person, within the workflow's role (**Creates records with the role**, or the AI settings' when unset). Text a model reads in a run, such as a parent record's body, can't make it write anywhere: models only fill the fields of the record they're asked for.

Covered by `tests/unit/agent-tools.test.ts`, `tests/unit/ai-plugin.test.ts` and `tests/integration/ai.test.ts`, which run the real routes against a fake OpenAI-compatible server.

## 6. Not yet

- The assistant as a panel on every dashboard page, not only its own page. That needs a dashboard-wide slot in core.
- Schema tools, so an agent can create collections. Schema changes need a fresh session and take no API keys (the security model), so these would be assistant-only and need their own design.
- MCP sign-in by OAuth, for clients that won't take an API key header.
- Alt text from an upload. Workflows draw pictures, but nothing reads them yet.
- Putting a picture the assistant drew on a record by itself. There's no agent tool for files in core yet, so the person adds it to the files and chooses it.
- Workflows that update existing records, such as translating a course, rather than only creating new ones.
