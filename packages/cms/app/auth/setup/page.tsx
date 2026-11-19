import SetupForm from "./setup-form";

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <SetupForm token={token ?? ""} />;
}
