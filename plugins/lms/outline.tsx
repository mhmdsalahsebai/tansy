"use client";

import { adminPath, apiPath, translate, useT, type RecordPanelProps } from "tansy/admin";

/** Enrolls each address that has an account. Says how many, never which, as the route does. */
export async function enrollByEmail(course: number, typed: string) {
  const emails = [...new Set(typed.split(/[\s,;]+/).map((email) => email.trim()).filter(Boolean))];
  const response = await fetch(apiPath("/ext/lms/enrollments"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ course, emails }) });
  const json = await response.json().catch(() => null) as { enrolled?: number; already?: number; unknown?: number; error?: { message?: string } } | null;
  if (!response.ok) return json?.error?.message ?? translate("ext.lms.enroll.failed");
  const counts = { enrolled: json?.enrolled ?? 0, already: json?.already ?? 0, unknown: json?.unknown ?? 0 };
  return translate(counts.unknown ? "ext.lms.enroll.resultUnknown" : "ext.lms.enroll.result", counts);
}

/** On a course, section or lesson, a way back to the course builder, where its outline is edited. */
export function BuilderPanel({ collection, recordId, values }: RecordPanelProps) {
  const { t } = useT();
  const course = collection.slug === "lms-courses" ? Number(recordId) : Number(values.course);
  if (!["lms-courses", "lms-sections", "lms-lessons", "lms-quizzes"].includes(collection.slug) || !Number.isSafeInteger(course) || course <= 0) return null;
  return (
    <section className="cms-panel cms-cell">
      <p className="cms-text-sm">
        {t("ext.lms.enroll.builderPanel", { link: "\u0000" }).split("\u0000").flatMap((part, index) => (index ? [<a key="link" className="cms-link" href={adminPath(`/ext/lms/courses/${course}`)}>{t("ext.lms.enroll.builderLink")}</a>, part] : [part]))}
      </p>
    </section>
  );
}
