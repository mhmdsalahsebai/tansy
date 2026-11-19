import { createElement, type ComponentType, type ReactNode } from "react";
import type { Block } from "../../core/blocks/limits";
import { safeHref, type RichNode } from "../../core/fields/rich-text";
import { mergeMessages, messagesFor, type Messages } from "../../core/i18n/messages";
import type { TemplateProps, ThemeQuery } from "../../core/theme/define";
import { TANSY_SITE_MESSAGES, PLUGIN_WORDS_LOCALE, type SiteWords } from "../../core/site/words";
import type { EveryPageInfo } from "../../core/site/page";

export interface BlockProps {
  block: Block;
  value: Block["value"];
  /** Pass these to a nested <StreamField>. */
  components: BlockComponents;
  theme?: Renderers;
  renderers?: Renderers;
  fallback?: ComponentType<BlockProps>;
  /**
   * The page's words, for `siteWords(words).t("shop.addToCart")`. Outside a page, as in the
   * dashboard's preview, the plugins' own words in their first language. `<StreamField>` always
   * passes them. Optional only so code that builds these props by hand keeps compiling.
   */
  words?: SiteWords;
}

export type BlockComponents = Record<string, ComponentType<BlockProps>>;

export interface FieldRenderProps {
  type: string;
  value: unknown;
}

/** What a plugin's component on every page gets. */
export interface EveryPageProps<P = Record<string, unknown>> {
  page: EveryPageInfo;
  /** What the plugin's `everyPage` function of the same name returned for this page. */
  props: P;
  /** The page's words. */
  words?: SiteWords;
}

/** What a plugin's `render` module exports by default. It may run anywhere, so keep server code out of it. */
export interface Renderers {
  blocks?: BlockComponents;
  fields?: Record<string, ComponentType<FieldRenderProps>>;
  /**
   * Site pages for the plugin's own collections, by collection slug, which must start with
   * the plugin's name and a hyphen. Rendered inside the theme's layout. A theme's template
   * for the same slug wins, so a theme can restyle a plugin's pages.
   */
  templates?: Record<string, ComponentType<TemplateProps>>;
  /** Per template above, the lists it needs. Each runs as a signed-out visitor. */
  queries?: Record<string, Record<string, ThemeQuery>>;
  /** Per collection slug above, what to expand on its record pages. */
  expand?: Record<string, string>;
  /**
   * Components on every page of the site, by name, such as an analytics tracker. Each
   * shows on a page only when the plugin's `everyPage` function of the same name returns
   * props for it. They render after the page's layout, inside the site's root.
   */
  everyPage?: Record<string, ComponentType<EveryPageProps>>;
  /**
   * The words visitors see on the plugin's pages and blocks, by language, in ICU format and
   * nested under the plugin's name: `{ en: { shop: { addToCart: "Add to cart" } } }`. English
   * comes first, and other languages fall back to it. Templates and blocks show them with
   * `t("shop.addToCart")`. Themes and owners can word any of them differently.
   */
  messages?: Record<string, Messages>;
}

export const defineRenderers = (renderers: Renderers) => renderers;

/**
 * Checks that a plugin's site pages are only for its own collections, so one plugin can't
 * take over another's pages. `tansy sync` wraps each plugin's renderers in this.
 */
export function pluginRenderers(plugin: string, renderers: Renderers): Renderers {
  const prefix = `${plugin}-`;
  for (const [slot, map] of Object.entries({ templates: renderers.templates, queries: renderers.queries, expand: renderers.expand, everyPage: renderers.everyPage })) {
    const outside = Object.keys(map ?? {}).find((slug) => !slug.startsWith(prefix));
    if (outside) throw new Error(`Plugin "${plugin}": ${slot} names "${outside}". A plugin's site pages are for its own collections, whose slugs start with "${prefix}".`);
  }
  // Words nest under the plugin's name, so one plugin can't word another's pages.
  for (const [locale, messages] of Object.entries(renderers.messages ?? {})) {
    const outside = Object.keys(messages ?? {}).find((key) => key !== plugin);
    if (outside) throw new Error(`Plugin "${plugin}": messages.${locale} has "${outside}". A plugin's site words nest under its name, as { ${locale}: { "${plugin}": { … } } }.`);
  }
  return renderers;
}

function mergeOne<T>(parts: Array<Record<string, T> | undefined>) {
  const merged: Record<string, T> = {};
  for (const [name, value] of parts.flatMap((part) => Object.entries(part ?? {}))) {
    if (Object.hasOwn(merged, name)) throw new Error(`Two plugins render "${name}". Remove one of them.`);
    merged[name] = value;
  }
  return merged;
}

/** Each language's words from every plugin. They nest under each plugin's name, so a clash means the same plugin twice. */
function mergeWords(parts: Array<Record<string, Messages> | undefined>) {
  const merged: Record<string, Messages> = {};
  for (const part of parts) {
    for (const [locale, messages] of Object.entries(part ?? {})) {
      merged[locale] = { ...mergeOne([merged[locale] as Record<string, unknown>, messages as Record<string, unknown>]) } as Messages;
    }
  }
  return merged;
}

/** Joins plugins' renderers. A clash throws rather than silently replacing a component. */
export const mergeRenderers = (parts: Renderers[]): Renderers => ({
  blocks: mergeOne(parts.map((part) => part.blocks)),
  fields: mergeOne(parts.map((part) => part.fields)),
  templates: mergeOne(parts.map((part) => part.templates)),
  queries: mergeOne(parts.map((part) => part.queries)),
  expand: mergeOne(parts.map((part) => part.expand)),
  everyPage: mergeOne(parts.map((part) => part.everyPage)),
  messages: mergeWords(parts.map((part) => part.messages)),
});

const own = <T,>(map: Record<string, T> | undefined, name: string) => (map && Object.hasOwn(map, name) ? map[name] : undefined);

/** Plugins' own words in their first language, for blocks shown outside a page. */
const ownWords = (renderers: Renderers | undefined): SiteWords => ({ locale: PLUGIN_WORDS_LOCALE, messages: mergeMessages(messagesFor(TANSY_SITE_MESSAGES, [PLUGIN_WORDS_LOCALE]), messagesFor(renderers?.messages ?? {}, [PLUGIN_WORDS_LOCALE])) });

/**
 * Renders a stream field from the API's JSON, and works in server components.
 * Each block uses `components`, then the active theme's, then the plugin default from
 * `renderers`, then `fallback`, or nothing if none applies, such as when its type was removed.
 * Blocks get `words`: the page's, from a template's `stream`, or else the plugins' own.
 */
export function StreamField({ blocks, components = {}, theme, renderers, fallback, words }: { blocks: unknown; components?: BlockComponents; theme?: Renderers; renderers?: Renderers; fallback?: ComponentType<BlockProps>; words?: SiteWords }) {
  if (!Array.isArray(blocks)) return null;
  const pageWords = words ?? ownWords(renderers);
  return (blocks as Block[]).map((block) => {
    const component = own(components, block.type) ?? own(theme?.blocks, block.type) ?? own(renderers?.blocks, block.type) ?? fallback;
    return component ? createElement(component, { key: block.id, block, value: block.value, components, theme, renderers, fallback, words: pageWords }) : null;
  });
}

/** Renders one field's value with the theme's component or its plugin's default, for use inside a block component. */
export function FieldValue({ type, value, theme, renderers }: FieldRenderProps & { theme?: Renderers; renderers?: Renderers }) {
  const component = own(theme?.fields, type) ?? own(renderers?.fields, type);
  return component ? createElement(component, { type, value }) : null;
}

function applyMarks(text: ReactNode, marks: RichNode[] = []): ReactNode {
  return marks.reduce<ReactNode>((inner, mark) => {
    switch (mark.type) {
      case "bold": return <strong>{inner}</strong>;
      case "italic": return <em>{inner}</em>;
      case "strike": return <s>{inner}</s>;
      case "underline": return <u>{inner}</u>;
      case "code": return <code>{inner}</code>;
      case "link": {
        // Checked again here, so content that didn't come through the API still can't produce a script link.
        const href = safeHref(mark.attrs?.href);
        return href ? <a href={href} rel="noopener noreferrer nofollow">{inner}</a> : inner;
      }
      default: return inner;
    }
  }, text);
}

const children = (node: RichNode) => (node.content ?? []).map((child, index) => <RichNode key={index} node={child} />);

function RichNode({ node }: { node: RichNode }): ReactNode {
  switch (node.type) {
    case "doc": return children(node);
    case "text": return applyMarks(node.text ?? "", node.marks);
    case "paragraph": return <p>{children(node)}</p>;
    case "heading": {
      const level = Number(node.attrs?.level);
      return createElement(`h${level >= 1 && level <= 6 ? level : 2}`, null, children(node));
    }
    case "bulletList": return <ul>{children(node)}</ul>;
    case "orderedList": return <ol>{children(node)}</ol>;
    case "listItem": return <li>{children(node)}</li>;
    case "blockquote": return <blockquote>{children(node)}</blockquote>;
    case "codeBlock": return <pre><code>{children(node)}</code></pre>;
    case "horizontalRule": return <hr />;
    case "hardBreak": return <br />;
    // Unknown nodes are left out. Everything above is an element React escapes, never raw HTML.
    default: return null;
  }
}

/** Renders stored rich text as React elements. */
export function RichText({ doc }: { doc: unknown }) {
  return doc && typeof doc === "object" ? <RichNode node={doc as RichNode} /> : null;
}
