"use client";

import { useT, type BlockEditorDefinition, type BlockEditorProps } from "tansy/admin";
import { embedUrl } from "./logic";
import "./lms.css";

/*
 * The lesson and quiz blocks on the editor's canvas, built from the same markup and
 * classes as render.tsx, so they look as they will on the site and are edited in place.
 */

const text = (value: unknown) => (typeof value === "string" ? value : "");

function TextEditor({ Field }: BlockEditorProps) {
  const { t } = useT();
  return <Field name="body" placeholder={t("ext.lms.editors.startWriting")} />;
}

function VideoEditor({ block, selected, Field }: BlockEditorProps) {
  const { t } = useT();
  const file = text(block.value.file);
  const src = embedUrl(text(block.value.url));
  const hasTranscript = block.value.transcript !== undefined && block.value.transcript !== null;
  return (
    <figure className="lms-figure">
      {file
        ? <Field name="file" />
        : src
          // Inert until selected, so a click selects the block rather than playing the video.
          ? <div className="lms-embed" inert={!selected}><iframe src={src} title={text(block.value.title) || t("ext.lms.editors.video")} loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" /></div>
          : (
            <div className="lms-editor-placeholder">
              <Field name="file" placeholder={t("ext.lms.editors.uploadVideo")} />
              <p className="lms-muted">{t("ext.lms.editors.orPaste")}</p>
              <Field name="url" />
            </div>
          )}
      {selected && <div className="lms-editor-note"><Field name="title" placeholder={t("ext.lms.editors.videoTitle")} /></div>}
      {(selected || hasTranscript) && (
        <details open>
          <summary>{t("ext.lms.editors.transcript")}</summary>
          <Field name="transcript" placeholder={t("ext.lms.editors.addTranscript")} />
        </details>
      )}
    </figure>
  );
}

function DownloadEditor({ block, selected, Field }: BlockEditorProps) {
  const { t } = useT();
  const file = text(block.value.file);
  return (
    <div>
      <div className="lms-download lms-download-edit"><span aria-hidden="true">↓</span><Field name="label" placeholder={t("ext.lms.editors.download")} /></div>
      {(selected || !file) && <Field name="file" placeholder={t("ext.lms.editors.downloadFile")} />}
    </div>
  );
}

type Kind = "single" | "multiple" | "short";

/** Choices as rows, each with a control to mark it correct, writing `choices` and `correct` as the grader reads them. */
function QuestionEditor({ block, selected, setField, Field }: BlockEditorProps) {
  const { t } = useT();
  const kind: Kind = block.value.kind === "multiple" || block.value.kind === "short" ? block.value.kind : "single";
  const choices = Array.isArray(block.value.choices) ? block.value.choices.map((choice) => (typeof choice === "string" ? choice : "")) : [];
  const correct = block.value.correct;
  const marked = (Array.isArray(correct) ? correct : [correct]).filter((item): item is number => typeof item === "number");
  const accepted = (Array.isArray(correct) ? correct : [correct]).filter((item): item is string => typeof item === "string");

  const setChoices = (next: string[], nextMarked = marked) => {
    setField("choices", next.length ? next : "");
    const kept = nextMarked.filter((index) => index < next.length);
    setField("correct", kind === "multiple" ? (kept.length ? kept : "") : kept[0] ?? "");
  };
  const mark = (index: number) => {
    if (kind === "multiple") setField("correct", marked.includes(index) ? marked.filter((item) => item !== index) : [...marked, index].sort((a, b) => a - b));
    else setField("correct", index);
  };
  const remove = (index: number) => setChoices(choices.filter((_, at) => at !== index), marked.filter((item) => item !== index).map((item) => (item > index ? item - 1 : item)));

  return (
    <div className="lms-question-edit">
      <div className="lms-question-prompt"><Field name="prompt" placeholder={t("ext.lms.editors.ask")} /></div>
      {kind === "short" ? (
        <label className="lms-editor-note">
          {t("ext.lms.editors.accepted")}
          <textarea
            className="lms-editor-input"
            rows={Math.max(2, accepted.length + 1)}
            value={accepted.join("\n")}
            onChange={(event) => {
              const lines = event.target.value.split("\n");
              setField("correct", lines.some((line) => line.trim()) ? lines : "");
            }}
          />
        </label>
      ) : (
        <ol className="lms-choices-edit">
          {choices.map((choice, index) => (
            <li key={index}>
              <input
                type={kind === "multiple" ? "checkbox" : "radio"}
                name={`correct-${block.id}`}
                checked={marked.includes(index)}
                onChange={() => mark(index)}
                aria-label={t("ext.lms.editors.choiceCorrect", { number: index + 1 })}
                title={t("ext.lms.editors.correct")}
              />
              <input
                className="lms-editor-input"
                value={choice}
                placeholder={t("ext.lms.editors.choice", { number: index + 1 })}
                aria-label={t("ext.lms.editors.choice", { number: index + 1 })}
                onChange={(event) => setChoices(choices.map((item, at) => (at === index ? event.target.value : item)))}
              />
              {selected && <button type="button" className="lms-editor-remove" aria-label={t("ext.lms.editors.removeChoice", { number: index + 1 })} onClick={() => remove(index)}>×</button>}
            </li>
          ))}
          {(selected || !choices.length) && <li><button type="button" className="lms-editor-add" onClick={() => setChoices([...choices, ""])}>{t("ext.lms.editors.addChoice")}</button></li>}
        </ol>
      )}
      {(selected || (block.value.explanation !== undefined && block.value.explanation !== null)) && (
        <details open>
          <summary>{t("ext.lms.editors.explanation")}</summary>
          <Field name="explanation" placeholder={t("ext.lms.editors.why")} />
        </details>
      )}
    </div>
  );
}

export const blockEditors: BlockEditorDefinition[] = [
  { blocks: ["lms_text"], component: TextEditor },
  { blocks: ["lms_video"], component: VideoEditor },
  { blocks: ["lms_download"], component: DownloadEditor },
  { blocks: ["lms_question"], component: QuestionEditor },
];
