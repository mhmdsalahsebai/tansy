import SignInForm from "./signin-form";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; reauth?: string; error?: string }> }) {
  const { next, reauth, error } = await searchParams;
  return <SignInForm next={next} reauth={reauth === "1"} oauthError={Boolean(error)} />;
}
