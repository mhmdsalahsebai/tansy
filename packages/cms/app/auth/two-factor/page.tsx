import TwoFactorForm from "./two-factor-form";

export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <TwoFactorForm next={next} />;
}
