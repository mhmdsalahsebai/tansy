import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'tansy';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';

export const gitConfig = {
  user: 'mhmdsalahsebai',
  repo: 'tansy',
  branch: 'main',
};

/** The live demo, and the shared account anyone may sign in with. It resets every hour. */
export const demo = {
  url: 'https://tansy-demo.vercel.app/dashboard',
  email: 'demo@example.com',
  password: 'explore-tansy-demo',
};

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
