export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ startCms }, { default: config }] = await Promise.all([import("tansy/start"), import("./tansy.config")]);
  await startCms(config);
}
