"use client";

import type { Block } from "../../core/blocks/limits";
import { cn } from "../../lib/utils";
import { BlockIcon } from "../blocks/block-icons";
import type { EditorCatalog } from "../fields/types";
import { revealBlock, useEditorSelection } from "./editor-context";
import { blockSummary, isBlockList } from "./stream-ops";
import { useSchemaText, useT } from "../i18n";

function Tree({ blocks, catalog, issues, path }: { blocks: Block[]; catalog: EditorCatalog; issues: string[]; path: string }) {
  const selection = useEditorSelection();
  const schemaText = useSchemaText();
  return (
    <ul className="cms-outline" role="group">
      {blocks.map((block, index) => {
        const type = catalog.blockTypes.find((item) => item.name === block.type);
        const at = `${path}.${index}`;
        const invalid = issues.some((key) => key === at || key.startsWith(`${at}.`));
        const nested = Object.entries(block.value).filter((entry): entry is [string, Block[]] => isBlockList(entry[1]));
        return (
          <li key={block.id} role="treeitem" aria-selected={selection?.selected === block.id}>
            <button
              type="button"
              className={cn("cms-outline-row", selection?.selected === block.id && "cms-outline-row-active", invalid && "cms-danger")}
              onClick={() => { selection?.select(block.id); revealBlock(block.id); }}
            >
              <BlockIcon name={type?.icon} />
              <span className="cms-outline-label">{type ? schemaText.block(type) : block.type}</span>
              <span className="cms-outline-summary">{blockSummary(block, 40)}</span>
            </button>
            {nested.map(([name, children]) => <Tree key={name} blocks={children} catalog={catalog} issues={issues} path={`${at}.value.${name}`} />)}
          </li>
        );
      })}
    </ul>
  );
}

/** Every block on the page as a tree, to find and jump to one in a long record. */
export default function Outline({ streams, catalog, issues }: { streams: Array<{ name: string; label: string; blocks: Block[] }>; catalog: EditorCatalog; issues: string[] }) {
  const { t } = useT();
  const filled = streams.filter((stream) => stream.blocks.length);
  if (!filled.length) return <p className="cms-muted">{t("stream.outline.empty")}</p>;
  return (
    <div className="cms-stack-4" role="tree" aria-label={t("stream.outline.label")}>
      {filled.map((stream) => (
        <div key={stream.name}>
          {streams.length > 1 && <p className="cms-side-label">{stream.label}</p>}
          <Tree blocks={stream.blocks} catalog={catalog} issues={issues} path={stream.name} />
        </div>
      ))}
    </div>
  );
}
