import type { ResolvedWebStyling } from '../../lib/web-styling';

export interface BillboardOptions {
  readonly workspaceName: string;
  readonly surfaces: readonly string[];
  readonly services: readonly string[];
  readonly commands: readonly string[];
}

const CSS = `
.main { min-height: 100vh; background: #09090b; color: #fafafa; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.container { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 72px 0; }
.eyebrow, .pill { display: inline-flex; width: fit-content; border: 1px solid #3f3f46; border-radius: 999px; padding: 6px 12px; font-size: 14px; }
.eyebrow { background: #fde047; border-color: #fde047; color: #18181b; font-weight: 700; }
.title { max-width: 900px; margin: 28px 0 18px; font-size: clamp(44px, 8vw, 84px); line-height: .96; letter-spacing: -.055em; }
.lede { max-width: 760px; color: #d4d4d8; font-size: 20px; line-height: 1.6; }
.section { margin-top: 64px; }
.section h2 { margin-bottom: 18px; font-size: 28px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; }
.card { border: 1px solid #27272a; border-radius: 18px; background: #18181b; padding: 22px; }
.card h3 { margin: 0 0 10px; font-size: 20px; }
.muted { color: #a1a1aa; line-height: 1.6; }
.commands { display: grid; gap: 10px; }
.command { overflow-x: auto; border: 1px solid #3f3f46; border-radius: 10px; background: #18181b; padding: 12px 14px; color: #fde047; }
.link { color: #fde047; text-underline-offset: 4px; }
`;

function data(options: BillboardOptions): string {
  return `const commands = ${JSON.stringify(options.commands)};
const surfaces: string[] = ${JSON.stringify(options.surfaces)};
const services: string[] = ${JSON.stringify(options.services)};
const tools = [
  ['Megamono', 'https://megamono.com', 'Explore Megamono'],
  ['Playstack', 'https://playstack.dev', 'Explore Playstack'],
  ['Springbar', 'https://springbar.app', 'Explore Springbar'],
  ['Commune Software', 'https://www.commune.software', 'Visit Commune Software'],
] as const;`;
}

function semanticMarkup(
  options: BillboardOptions,
  classes: Record<string, string>,
): string {
  const attribute = (name: string) => `className={${classes[name]}}`;
  return `<>
      <Head><title>${options.workspaceName} · Built with Megamono</title></Head>
      <main ${attribute('main')}>
        <div ${attribute('container')}>
          <span ${attribute('eyebrow')}>Commune development tools</span>
          <h1 ${attribute('title')}>${options.workspaceName} is ready to build.</h1>
          <p ${attribute('lede')}>Megamono prepared this workspace so people and agents can build against the same architecture.</p>
          <section ${attribute('section')}><h2>Generated surfaces</h2><div ${attribute('grid')}>
            {surfaces.map((surface) => <span ${attribute('pill')} key={surface}>{surface}</span>)}
          </div></section>
          <section ${attribute('section')}><h2>Requested services</h2><div ${attribute('grid')}>
            {(services.length ? services : ['None requested']).map((service) => <span ${attribute('pill')} key={service}>{service}</span>)}
          </div></section>
          <section ${attribute('section')}><h2>How to use Megamono</h2>
            <p ${attribute('muted')}>Keep applications thin composition roots, place reusable behavior in tagged libraries, and capture durable intent in docs.</p>
            <div ${attribute('commands')}>{commands.map((command) => <code ${attribute('command')} key={command}>{command}</code>)}</div>
          </section>
          <section ${attribute('section')}><h2>Keep building with Commune</h2><div ${attribute('grid')}>
            {tools.map(([name, href, label]) => <article ${attribute('card')} key={name}><h3>{name}</h3><a ${attribute('link')} href={href} target="_blank" rel="noreferrer">{label}</a></article>)}
          </div></section>
        </div>
      </main>
    </>`;
}

const moduleClasses = Object.fromEntries(
  [
    'main',
    'container',
    'eyebrow',
    'title',
    'lede',
    'section',
    'grid',
    'pill',
    'muted',
    'commands',
    'command',
    'card',
    'link',
  ].map((name) => [name, `styles.${name}`]),
);

const stylexClasses = Object.fromEntries(
  Object.keys(moduleClasses).map((name) => [
    name,
    `stylex.props(styles.${name}).className`,
  ]),
);

function objectStyles(): string {
  return `{
  main: { minHeight: '100vh', background: '#09090b', color: '#fafafa', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  container: { width: 'min(1120px, calc(100% - 40px))', margin: '0 auto', padding: '72px 0' },
  eyebrow: { display: 'inline-flex', width: 'fit-content', border: '1px solid #fde047', borderRadius: 999, padding: '6px 12px', fontSize: 14, background: '#fde047', color: '#18181b', fontWeight: 700 },
  title: { maxWidth: 900, margin: '28px 0 18px', fontSize: 'clamp(44px, 8vw, 84px)', lineHeight: .96, letterSpacing: '-.055em' },
  lede: { maxWidth: 760, color: '#d4d4d8', fontSize: 20, lineHeight: 1.6 },
  section: { marginTop: 64 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 16 },
  pill: { display: 'inline-flex', width: 'fit-content', border: '1px solid #3f3f46', borderRadius: 999, padding: '6px 12px', fontSize: 14 },
  muted: { color: '#a1a1aa', lineHeight: 1.6 },
  commands: { display: 'grid', gap: 10 },
  command: { overflowX: 'auto', border: '1px solid #3f3f46', borderRadius: 10, background: '#18181b', padding: '12px 14px', color: '#fde047' },
  card: { border: '1px solid #27272a', borderRadius: 18, background: '#18181b', padding: 22 },
  link: { color: '#fde047', textUnderlineOffset: 4 },
}`;
}

function cssModulesSource(options: BillboardOptions): string {
  return `import Head from 'next/head';
import styles from './index.module.css';

${data(options)}

export default function Index() {
  return (${semanticMarkup(options, moduleClasses)});
}
`;
}

function emotionSource(options: BillboardOptions): string {
  const emotionClasses = Object.fromEntries(
    Object.keys(moduleClasses).map((name) => [name, `styles.${name}`]),
  );
  return `/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react';
import Head from 'next/head';

${data(options)}
const styles = Object.fromEntries(Object.entries(${objectStyles()}).map(([name, value]) => [name, css(value)])) as Record<string, ReturnType<typeof css>>;

export default function Index() {
  return (${semanticMarkup(options, emotionClasses).replaceAll('className=', 'css=')});
}
`;
}

function stylexSource(options: BillboardOptions): string {
  return `import * as stylex from '@stylexjs/stylex';
import Head from 'next/head';

${data(options)}
const styles = stylex.create(${objectStyles()});

export default function Index() {
  return (${semanticMarkup(options, stylexClasses)});
}
`;
}

function pandaSource(options: BillboardOptions): string {
  return `import Head from 'next/head';
import { css } from '../../styled-system/css';

${data(options)}
const styles = {
  main: css({ minHeight: '100vh', background: '#09090b', color: '#fafafa', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' }),
  container: css({ width: 'min(1120px, calc(100% - 40px))', margin: '0 auto', padding: '72px 0' }),
  eyebrow: css({ display: 'inline-flex', width: 'fit-content', border: '1px solid #fde047', borderRadius: '999px', padding: '6px 12px', fontSize: '14px', background: '#fde047', color: '#18181b', fontWeight: '700' }),
  title: css({ maxWidth: '900px', margin: '28px 0 18px', fontSize: 'clamp(44px, 8vw, 84px)', lineHeight: '.96', letterSpacing: '-.055em' }),
  lede: css({ maxWidth: '760px', color: '#d4d4d8', fontSize: '20px', lineHeight: '1.6' }),
  section: css({ marginTop: '64px' }),
  grid: css({ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '16px' }),
  pill: css({ display: 'inline-flex', width: 'fit-content', border: '1px solid #3f3f46', borderRadius: '999px', padding: '6px 12px', fontSize: '14px' }),
  muted: css({ color: '#a1a1aa', lineHeight: '1.6' }),
  commands: css({ display: 'grid', gap: '10px' }),
  command: css({ overflowX: 'auto', border: '1px solid #3f3f46', borderRadius: '10px', background: '#18181b', padding: '12px 14px', color: '#fde047' }),
  card: css({ border: '1px solid #27272a', borderRadius: '18px', background: '#18181b', padding: '22px' }),
  link: css({ color: '#fde047', textUnderlineOffset: '4px' }),
};

export default function Index() {
  return (${semanticMarkup(options, moduleClasses)});
}
`;
}

function inlineSource(options: BillboardOptions): string {
  return `import Head from 'next/head';
import type { CSSProperties } from 'react';

${data(options)}
const styles = ${objectStyles()} satisfies Record<string, CSSProperties>;

export default function Index() {
  return (${semanticMarkup(options, moduleClasses).replaceAll('className=', 'style=')});
}
`;
}

function tailwindSource(options: BillboardOptions): string {
  const classes = {
    main: "'min-h-screen bg-zinc-950 text-zinc-50'",
    container: "'mx-auto w-[min(1120px,calc(100%_-_40px))] py-20'",
    eyebrow:
      "'inline-flex rounded-full border border-yellow-300 bg-yellow-300 px-3 py-1 text-sm font-bold text-zinc-950'",
    title:
      "'my-7 max-w-4xl text-5xl font-bold leading-none tracking-[-.055em] md:text-8xl'",
    lede: "'max-w-3xl text-xl leading-relaxed text-zinc-300'",
    section: "'mt-16'",
    grid: "'grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-4'",
    pill: "'inline-flex w-fit rounded-full border border-zinc-700 px-3 py-1 text-sm'",
    muted: "'leading-relaxed text-zinc-400'",
    commands: "'grid gap-2.5'",
    command:
      "'overflow-x-auto rounded-xl border border-zinc-700 bg-zinc-900 px-3.5 py-3 text-yellow-300'",
    card: "'rounded-2xl border border-zinc-800 bg-zinc-900 p-5'",
    link: "'text-yellow-300 underline-offset-4'",
  };
  return `import Head from 'next/head';

${data(options)}

export default function Index() {
  return (${semanticMarkup(options, classes)});
}
`;
}

export function billboardSource(
  options: BillboardOptions,
  styling: ResolvedWebStyling,
): string {
  if (styling === 'emotion') return emotionSource(options);
  if (styling === 'tailwind') return tailwindSource(options);
  if (styling === 'panda') return pandaSource(options);
  if (styling === 'stylex') return stylexSource(options);
  if (styling === 'inline') return inlineSource(options);
  return cssModulesSource(options);
}

export function billboardCss(): string {
  return `${CSS.trim()}\n`;
}
