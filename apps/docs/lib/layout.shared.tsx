import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Image from 'next/image';
import { appName, gitConfig } from './shared';

/** The mark and the wordmark, whose dark letters are swapped for light ones on the dark theme. */
function Brand() {
  return (
    <span className="inline-flex items-center gap-2">
      <Image src="/brand/icon.png" alt="" width={24} height={24} className="size-6" priority />
      <Image src="/brand/logo-dark.png" alt={appName} width={65} height={20} className="h-5 w-auto dark:hidden" priority />
      <Image src="/brand/logo-light.png" alt={appName} width={72} height={20} className="hidden h-5 w-auto dark:block" priority />
    </span>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Brand />,
    },
    links: [
      { text: 'Documentation', url: '/docs', active: 'nested-url' },
      { text: 'Plugins', url: '/docs/plugins' },
      { text: 'Themes', url: '/docs/themes' },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
