import { z } from "zod";
import { defineTool, type AgentToolContext, type RecordValues } from "tansy/plugin";
import { idOf, listAll } from "./service";

const markdown = (what: string) => z.string().max(100_000).describe(`${what}, in Markdown`);

const lesson = z.object({
  title: z.string().min(1).max(200),
  content: markdown("The lesson's text").optional(),
  durationMinutes: z.number().int().min(0).max(10_000).optional(),
  preview: z.boolean().optional().describe("Open to everyone, enrolled or not"),
});

const courseInput = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(500).optional().describe("One or two sentences for course lists"),
  description: markdown("What the course covers, for its page").optional(),
  level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  access: z.enum(["free", "enrollment"]).optional().describe("free: anyone signed in can enroll. enrollment: staff enroll learners. Selling a course is set up in the dashboard"),
  estimatedMinutes: z.number().int().min(0).max(100_000).optional(),
  sections: z.array(z.object({ title: z.string().min(1).max(200), lessons: z.array(lesson).max(100) })).max(50),
});

/** Owners can remove fields, so only the ones the collection still has are written. */
async function keep(context: AgentToolContext, slug: string, values: RecordValues) {
  const names = new Set((await context.schema.describe(slug))?.fields.map((field) => field.name) ?? []);
  return Object.fromEntries(Object.entries(values).filter(([name, value]) => value !== undefined && names.has(name)));
}

/** A stream of one text block. create_record turns the Markdown into rich text and fills in the block's id and version. */
const textStream = (text: string | undefined) => (text?.trim() ? [{ type: "lms_text", value: { body: text } }] : undefined);

const create = async (context: AgentToolContext, slug: string, values: RecordValues) =>
  (await context.tools.call("create_record", { collection: slug, data: await keep(context, slug, values) })) as RecordValues;

/** What an AI agent can do with courses, as whoever asked: instructors only in their own courses. */
export const lmsTools = [
  defineTool({
    name: "lms_create_course",
    description: "Create a whole course in one step: the course, its sections in order and each section's lessons with their text. Everything is saved as a draft for a person to review and publish. Covers, videos, downloads and quizzes are added afterwards in the course builder.",
    input: courseInput,
    access: { access: "authenticated" },
    write: true,
    audit: "lms.create_course",
    handler: async (context) => {
      const { sections, description, ...course } = context.input;
      const created = await create(context, "lms-courses", { ...course, description: textStream(description), status: "draft" });
      const courseId = idOf(created.id);
      if (courseId === null) throw new Error("The course was created without an id.");
      let lessons = 0;
      for (const [position, section] of sections.entries()) {
        const made = await create(context, "lms-sections", { title: section.title, course: courseId, position, status: "draft" });
        for (const [index, item] of section.lessons.entries()) {
          await create(context, "lms-lessons", { title: item.title, course: courseId, section: idOf(made.id), position: index, preview: item.preview, durationMinutes: item.durationMinutes, content: textStream(item.content), status: "draft" });
          lessons++;
        }
      }
      return { course: { id: courseId, title: created.title, slug: created.slug }, sections: sections.length, lessons };
    },
  }),
  defineTool({
    name: "lms_outline",
    description: "A course's sections and lessons in order, with their ids, as you can see them. Use it before adding to or reorganising a course.",
    input: z.object({ course: z.number().int().positive().describe("The course's record id") }),
    access: { access: "authenticated" },
    write: false,
    handler: async ({ records, input }) => {
      const course = await records.get("lms-courses", input.course, { fields: "id,title,slug,status" });
      const filter = `course = ${input.course}`;
      const [sections, lessons] = await Promise.all([
        listAll(records, "lms-sections", { filter, sort: "position,id", fields: "id,title,position,status" }),
        listAll(records, "lms-lessons", { filter, sort: "position,id", fields: "id,title,section,position,preview,status" }),
      ]);
      return {
        course,
        sections: sections.map((section) => ({ ...section, lessons: lessons.filter((item) => item.section === section.id) })),
        withoutSection: lessons.filter((item) => !sections.some((section) => section.id === item.section)),
      };
    },
  }),
];
