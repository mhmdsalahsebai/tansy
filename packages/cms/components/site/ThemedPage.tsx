import { createElement, type ComponentType } from "react";
import { streamProps, type LoadedPage, type SiteTheme } from "../../core/site/page";
import { siteWords } from "../../core/site/words";
import type { LayoutProps, TemplateProps, ThemeComponents } from "../../core/theme/define";
import { siteTokenDeclarations } from "../../core/theme/tokens";
import type { BlockProps, Renderers } from "../stream/StreamField";

function MissingBlock({ block, words }: BlockProps) {
  return <p role="note" data-missing-block={block.type}>{siteWords(words).t("cms.missingBlock", { type: block.type })}</p>;
}

/**
 * Renders a page from loadSitePage. No server imports, so a headless site renders the
 * same theme through the same code. Tokens go on a wrapper rather than :root, so this
 * works inside whatever root layout the site has.
 */
export function ThemedPage<Options>({ theme, page, renderers, exitPreviewHref }: {
  theme: SiteTheme<Options>;
  page: Extract<LoadedPage<Options>, { type: "page" }>;
  renderers?: Renderers;
  /** Where the preview notice's exit link goes. Without it, no link is shown. */
  exitPreviewHref?: string;
}) {
  const components = theme.components;
  const tokens = siteTokenDeclarations(theme.manifest.tokens ?? {}, page.accent);
  const props = { ...page.props, stream: { ...streamProps(components as ThemeComponents, renderers, page.props.words), fallback: MissingBlock } } as TemplateProps<Options>;
  const Template = (page.source === "plugin" ? renderers?.templates?.[page.template] : components.templates[page.template]) as ComponentType<TemplateProps<Options>> | undefined;
  if (!Template) throw new Error(`The "${page.template}" page comes from a plugin. Pass the same renderers to ThemedPage as to loadSitePage.`);
  const layouts = components.layouts ?? {};
  const Layout = (Object.hasOwn(layouts, page.template) ? layouts[page.template] : layouts.default) as ComponentType<LayoutProps<Options>> | undefined;
  const content = createElement(Template, props);

  return (
    <div className={["site-root", components.fontClassName].filter(Boolean).join(" ")} data-theme={theme.manifest.name} lang={page.props.language?.locale} dir={page.props.language?.direction}>
      {tokens && <style>{`.site-root{${tokens}}`}</style>}
      {page.props.preview && (
        <p role="status" data-preview-notice="">
          {page.props.t("cms.preview")}{exitPreviewHref && <> <a href={exitPreviewHref}>{page.props.t("cms.exitPreview")}</a></>}
        </p>
      )}
      {Layout ? <Layout {...props}>{content}</Layout> : content}
      {page.everyPage && Object.entries(page.everyPage.props).map(([name, partProps]) => {
        const Part = renderers?.everyPage && Object.hasOwn(renderers.everyPage, name) ? renderers.everyPage[name] : undefined;
        return Part ? <Part key={name} page={page.everyPage!.page} props={partProps as Record<string, unknown>} words={page.props.words} /> : null;
      })}
    </div>
  );
}
