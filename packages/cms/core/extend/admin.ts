import type { ComponentType } from "react";
import type { Permission } from "../authz/permissions";
import type { BlockComponents, FieldRenderProps } from "../../components/stream/StreamField";
import type { ThemeTokens } from "../theme/tokens";
import type { RecordsApi } from "./define";

export interface AdminPageProps {
  /** As the signed-in person, so API rules apply. */
  records: RecordsApi;
  user: { id: string; email: string; permissions: string[] };
  /** The values of the page path's `:name` segments. Untrusted: check them before use. */
  params: Record<string, string>;
}

export interface AdminPage {
  /**
   * Served at /dashboard/ext/<path>. `:name` segments match one part of the address and
   * reach the page as `params`, such as "lms/courses/:id". Such a page isn't in the navigation.
   */
  path: string;
  title: string;
  /** Needed to open the page and to see it in the navigation. */
  permission?: Permission;
  /**
   * A collection slug. Opening the page, and seeing it in the navigation, then also needs
   * permission to list that collection's records, all of them or only one's own. For a page
   * that works on one collection, such as a builder for its records.
   */
  collection?: string;
  component: ComponentType<AdminPageProps>;
}

export interface AdminWidget {
  id: string;
  title: string;
  permission?: Permission;
  component: ComponentType<AdminPageProps>;
}

/** A link in the admin's navigation, for a page that isn't one of the plugin's own `pages`. */
export interface AdminNavItem {
  title: string;
  /** Under the admin path, such as /collections/3. */
  path: string;
  permission: Permission;
}

/** One entry in a plugin's section of the navigation. Each shows only to someone who may open what it links to. */
export type AdminSectionItem =
  /** One of the plugin's own `pages`, by path. Its title unless `title` is given. */
  | { page: string; title?: string }
  /** A collection, by slug. Shows to anyone who may list its records, all or only their own. */
  | { collection: string; title?: string }
  /** The plugin's settings form, from `settings` in its manifest. */
  | { settings: true; title?: string };

/**
 * An icon a plugin brings itself, as SVG path data, drawn in the navigation's colour at its
 * icon size. Data rather than a component, so it reaches the navigation, which runs in the
 * browser, from the server. Paths that aren't plain path data are ignored.
 */
export interface AdminIcon {
  /** Each path's `d` attribute. */
  paths: string[];
  /** "0 0 16 16" when left out. */
  viewBox?: string;
  /** "nonzero" when left out. */
  fillRule?: "nonzero" | "evenodd";
}

/**
 * The plugin's own entry in the navigation, opening to its items. Pages the section names
 * leave the shared Plugins group, and collections whose slug starts with the plugin's name
 * and a hyphen are listed under its title on the Collections page. When only one item shows,
 * as for a plugin that does everything on one page, the entry is a single link to it.
 */
export interface AdminSection {
  title: string;
  /** The plugin's own icon, or one of the navigation's built-in names, such as "academic", "newspaper" or "book". */
  icon?: string | AdminIcon;
  items: AdminSectionItem[];
}

/**
 * A button at the end of the dashboard's top bar that opens one of the plugin's `pages`, for
 * something people reach for from anywhere, such as an assistant. It shows only to someone who
 * may open that page.
 */
export interface AdminShortcut {
  /** One of the plugin's own `pages`, by path. */
  page: string;
  /** The button's name for screen readers and its tooltip. The page's title when left out. */
  title?: string;
  /** The plugin's own icon, or one of the navigation's built-in names. */
  icon?: string | AdminIcon;
}

/**
 * A choice in the dashboard's top bar that applies to every page, such as the tenant someone
 * works in. The plugin's own routes supply it: `options` is a GET route answering
 * `{ current, options: [{ value, label }] }`, where `value` may be null for "none", and
 * `select` a POST route that receives `{ value }`. The dashboard reloads after a choice. The
 * routes check for themselves: the switcher only offers what `options` returns.
 */
export interface AdminSwitcher {
  /** What is being chosen, such as "Tenant", for screen readers and the tooltip. Its word is `switcher`. */
  label: string;
  /** One of the plugin's GET routes, such as "/switcher". */
  options: string;
  /** One of the plugin's POST routes. */
  select: string;
  /** Shows the switcher only to holders. Left out, it shows to everyone the `options` route answers with a choice. */
  permission?: Permission;
}

/** What an account panel receives. Anyone signed in can open the account page, staff or not. */
export interface AccountPanelProps {
  user: { id: string; email: string; permissions: string[] };
}

/**
 * A card on the account page, which everyone signed in can open, including people with no
 * dashboard access, such as someone invited to a tenant who hasn't accepted yet. Only for what
 * concerns the person themself. The routes it calls check for themselves.
 */
export interface AccountPanel {
  id: string;
  component: ComponentType<AccountPanelProps>;
}

/** What a plugin's `admin.server` module exports by default. Server components, kept out of the manifest so API routes never import React. */
export interface AdminPluginParts { pages?: AdminPage[]; widgets?: AdminWidget[]; navItems?: AdminNavItem[]; section?: AdminSection; shortcut?: AdminShortcut; switcher?: AdminSwitcher; accountPanels?: AccountPanel[] }

export interface AdminPlugin extends AdminPluginParts { name: string }

export interface AdminConfig {
  plugins: AdminPlugin[];
  /** Every plugin `tansy sync` saw, to tell when the maps no longer match the config. */
  synced: Array<{ name: string; version: string }>;
}

export const defineAdminPlugin = (parts: AdminPluginParts) => parts;

export interface FieldInputProps {
  id: string;
  field: { name: string; type: string; config?: Record<string, unknown> | null };
  value: unknown;
  onChange: (value: unknown) => void;
  /** Where the value sits, such as `body.0.value.link`, matching the paths in validation errors. */
  path: string;
  error?: string;
  disabled: boolean;
  /** The server refuses a changed value, so show it without offering to edit it. */
  readOnly: boolean;
}

export interface FieldConfigInputProps {
  /** Start the id of each control with this. */
  idPrefix: string;
  type: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  /** Validation errors by path. Look up `${issuePrefix}.<option>`. */
  issues: Record<string, string>;
  issuePrefix: string;
}

export interface FieldAdminDefinition {
  type: string;
  /** Replaces the built-in control in record forms and blocks. */
  Input?: ComponentType<FieldInputProps>;
  /** Replaces the form generated from the `config` schema for this type's own options. The server still validates against the schema. */
  ConfigInput?: ComponentType<FieldConfigInputProps>;
  /** Replaces the plain text in the record grid. */
  Cell?: ComponentType<{ value: unknown }>;
  /**
   * How a value of this type shows on a block's canvas, edited where it reads as it will
   * look, such as a map you drag a pin on. Without it the canvas uses `Input`, or the built-in control.
   */
  Canvas?: ComponentType<FieldCanvasProps>;
}

export interface FieldCanvasProps extends FieldInputProps {
  /** Whether the block holding the field is selected. Show editing controls only then. */
  selected: boolean;
}

export interface AuthWidgetProps {
  form: "signin" | "signup" | "forgot-password";
  /** From the extension's `authWidget.props`. */
  config: Record<string, unknown>;
  /** Goes up after each failed attempt, for widgets whose answer can be used only once. */
  attempt: number;
  /** Sent with this form's request. */
  setHeaders: (headers: Record<string, string>) => void;
}

export interface AuthWidgetDefinition { id: string; component: ComponentType<AuthWidgetProps> }

/** One field of the record form, as a plugin's slot sees it. */
export interface FormField { name: string; type: string; label: string; config: Record<string, unknown> }

export interface RecordPanelProps {
  collection: { id: number; slug: string; name: string };
  /** Missing on a new record. */
  recordId?: string;
  status: string;
  /** Current form values by field name, including unsaved edits. */
  values: Record<string, unknown>;
  /** The fields in the form, the ones this person can read. */
  fields: FormField[];
  /**
   * Changes fields in the form by name, as if the person had typed them. Nothing is saved:
   * they review and save as usual, and the server validates as usual. Names not in the
   * form, and fields that can't be changed, are left alone.
   */
  setValues(values: Record<string, unknown>): void;
}

/** Client component shown under the fields in the record editor. */
export interface RecordPanelDefinition { id: string; component: ComponentType<RecordPanelProps> }

export const defineFieldAdmin = (definition: FieldAdminDefinition) => definition;

/** Every slot below shows only to someone with its `permission`. That only decides what to offer: the routes a slot calls still check for themselves. */
export interface SlotCollection { id: number; slug: string; name: string }

export interface GridColumnDefinition {
  id: string;
  title: string;
  permission: Permission;
  /** Collection slugs. Every collection when left out. */
  collections?: string[];
  component: ComponentType<{ collection: SlotCollection; record: Record<string, unknown> }>;
}

export interface RecordActionDefinition {
  id: string;
  label: string;
  permission: Permission;
  collections?: string[];
  run(context: { collection: SlotCollection; record: Record<string, unknown>; refresh(): void }): void | Promise<void>;
}

export interface BulkActionDefinition {
  id: string;
  label: string;
  permission: Permission;
  collections?: string[];
  run(context: { collection: SlotCollection; ids: number[]; refresh(): void }): void | Promise<void>;
}

export interface FieldActionContext {
  collection: SlotCollection;
  /** Missing on a new record. */
  recordId?: string;
  field: FormField;
  value: unknown;
  /** Every field's current value by name, including unsaved edits. */
  values: Record<string, unknown>;
  /** Changes this field in the form. Nothing is saved until the person saves. */
  setValue(value: unknown): void;
}

/** A button by a field in the record form, such as one that writes the field with AI. */
export interface FieldActionDefinition {
  id: string;
  label: string;
  permission: Permission;
  /** Field types, such as ["text", "rich_text"]. Every type when left out. */
  types?: string[];
  collections?: string[];
  /** Your own control in place of a plain button, such as a menu. Gets the same context. */
  component?: ComponentType<FieldActionContext>;
  run?(context: FieldActionContext): void | Promise<void>;
}

export interface SettingsTabDefinition {
  id: string;
  title: string;
  permission: Permission;
  component: ComponentType;
}

export interface BlockActionDefinition {
  id: string;
  label: string;
  permission: Permission;
  /** Block names. Every block when left out. */
  blocks?: string[];
  run(context: { block: { id: string; type: string; value: Record<string, unknown> }; setValue(value: Record<string, unknown>): void }): void | Promise<void>;
}

export interface BlockFieldProps {
  /** One of the block's fields. */
  name: string;
  /** Classes for the control, so text takes the site's typography. */
  className?: string;
  placeholder?: string;
}

export interface BlockEditorProps {
  block: { id: string; type: string; value: Record<string, unknown> };
  /** Sets one field. An empty string or undefined clears it. */
  setField(name: string, value: unknown): void;
  /** Whether the block is selected. Show editing controls only then. */
  selected: boolean;
  /**
   * The CMS's own canvas control for one of the block's fields: text without a box, inline
   * rich text, nested blocks, or the field's usual control. Place it inside your own markup.
   */
  Field: ComponentType<BlockFieldProps>;
}

/**
 * How a block looks and is edited on the canvas, as a Gutenberg block's `edit` does. Render
 * the markup your site renders, with the editable fields in place, and the site's styles
 * apply. Fields you leave out of the canvas still show in the block's settings when their
 * placement puts them there, so a canvas field you don't render can't be edited.
 */
export interface BlockEditorDefinition {
  /** Block names. */
  blocks: string[];
  component: ComponentType<BlockEditorProps>;
}

/**
 * The site's own components and styles, for showing blocks on the canvas as they will look.
 * `tansy sync` writes it to .tansy/preview.ts.
 */
export interface SitePreview {
  /** The active theme's components, or null without a theme. */
  theme: { blocks?: BlockComponents; fields?: Record<string, ComponentType<FieldRenderProps>>; fontClassName?: string } | null;
  /** Plugins' front-end components. */
  renderers: { blocks?: BlockComponents; fields?: Record<string, ComponentType<FieldRenderProps>> };
  /** The theme's tokens, as --site- custom properties. */
  tokens?: ThemeTokens;
  /** Origins the Content Security Policy lets pages frame, so the canvas only embeds what will load. */
  frames?: string[];
}

/** What a plugin's `admin.client` module exports by default. This reaches the browser, so keep server code out of it. */
export interface AdminClientParts {
  fieldAdmin?: FieldAdminDefinition[];
  authWidgets?: AuthWidgetDefinition[];
  recordPanels?: RecordPanelDefinition[];
  fieldActions?: FieldActionDefinition[];
  gridColumns?: GridColumnDefinition[];
  recordActions?: RecordActionDefinition[];
  bulkActions?: BulkActionDefinition[];
  settingsTabs?: SettingsTabDefinition[];
  blockActions?: BlockActionDefinition[];
  blockEditors?: BlockEditorDefinition[];
}

export interface AdminClientPlugin extends AdminClientParts { name: string }

export const defineAdminClient = (parts: AdminClientParts) => parts;
