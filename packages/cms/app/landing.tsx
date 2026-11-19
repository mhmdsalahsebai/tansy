import { redirect } from "next/navigation";
import { resolveLanding } from "../core/authz/page";

export default async function Home() {
  redirect(await resolveLanding());
}
