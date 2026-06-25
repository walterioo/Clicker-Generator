import './style.css';
import { createStore } from './store/store';
import { createViewer } from './viewer/viewer';
import { createUi, type UiState } from './ui/ui';
import { loadFileToImage, type RgbaImage } from './image/decode';
import { processImage } from './image/pipeline';
import { runWizard } from './ui/wizard';
import { downloadThreeMF } from './export/threemfExport';
import { parseSvg } from './image/logo';
import { SVG_SAMPLES } from './image/sample';
import { parseLetter, importFontFile } from './image/letter';
import { LUCIDE_ICONS, buildSvg } from './image/lucideIcons';
import type {
  BuildParams,
  BuildRegion,
  ClickerPart,
  GeometryResponse,
  PaletteEntry,
  RegionSet,
  RGB,
} from './types';
import { FILAMENTS } from './types';

/** Which editable color a clicked model part maps back to. */
type ColorTarget = { kind: 'region'; index: number } | { kind: 'body' } | { kind: 'base' };

// ---- State (UI-facing) ----
const store = createStore<UiState>({
  status: 'Loading switch assets…',
  building: false,
  hasParts: false,
  colorCount: 4,
  palette: [],
  baseShape: 'outline',
  capWidthMm: 40,
  topThickness: 1.5,
  imageDepth: 0.8,
  tolerance: 0.4,
  smoothing: 0.65,
  keychain: false,
  removeBg: true,
  view: 'assembled',
  showSwitch: false,
  importMode: 'icon', // Default to 'icon' to show a live clicker immediately
  currentIconName: 'circle',
  colorMode: 'normal',
  limitedColors: [],
  bodyColorRgb: [120, 124, 130] as RGB,
  paletteOverrides: [],
  baseColorOverride: null,
});

// ---- Heavy data kept out of the reactive store ----
let originalImage: RgbaImage | null = null; // pristine decode (never mutated)
let regionSet: RegionSet | null = null;
let latestParts: ClickerPart[] = [];
let assetsReady = false;

// Vector states
let currentSvgText = '';
let currentSvgName = '';
let currentIconText = '';
let currentIconName = '';
let currentText = 'A';
let currentFontId = 'helvetiker-regular';
let isInitialLoad = true;

const hasImage = () => originalImage !== null;
function cloneImage(img: RgbaImage): RgbaImage {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

// ---- DOM / subsystems ----
const sidebarLeft = document.getElementById('sidebar-left')!;
const sidebarRight = document.getElementById('sidebar-right')!;
const statusEl = document.getElementById('status')!;
const viewer = createViewer(document.getElementById('app')!);

// ---- Apply initial theme (system pref or saved preference) ----
(function applyInitialTheme() {
  const saved = localStorage.getItem('clicker-theme');
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved ?? (systemDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  viewer.setTheme(theme);
})();

const ui = createUi(sidebarLeft, sidebarRight, statusEl, {
  onUpload: (file) => openWizard(() => loadFileToImage(file)),
  onSample: (load) => openWizard(load),
  onColorCount: (n) => {
    store.set({ colorCount: n });
    debouncedReprocess();
  },
  onFilament: (i, hex) => {
    const palette = store.get().palette.slice();
    if (palette[i]) {
      palette[i] = { ...palette[i], filamentRgb: hexToRgb(hex) };
      store.set({ palette });
      
      const overrides = store.get().paletteOverrides.slice();
      overrides[i] = hexToRgb(hex);
      store.set({ paletteOverrides: overrides });

      debouncedRebuild();
    }
  },
  onHeight: (i, level) => {
    const palette = store.get().palette.slice();
    if (palette[i]) {
      palette[i] = { ...palette[i], heightLevel: Math.max(0, Math.min(6, level)) };
      store.set({ palette });
      debouncedRebuild();
    }
  },
  onShape: (kind) => {
    store.set({ baseShape: kind });
    debouncedRebuild();
  },
  onWidth: (mm) => {
    store.set({ capWidthMm: mm });
    debouncedRebuild();
  },
  onTopThickness: (mm) => {
    store.set({ topThickness: mm });
    debouncedRebuild();
  },
  onImageDepth: (mm) => {
    store.set({ imageDepth: mm });
    debouncedRebuild();
  },
  onTolerance: (mm) => {
    store.set({ tolerance: mm });
    debouncedRebuild();
  },
  onKeychain: (on) => {
    store.set({ keychain: on });
    debouncedRebuild();
  },
  onSmoothing: (v) => {
    store.set({ smoothing: v });
    if (store.get().importMode === 'image' && hasImage()) debouncedReprocess();
  },
  onRemoveBg: (on) => {
    store.set({ removeBg: on });
    if (store.get().importMode === 'image' && hasImage()) reprocess();
  },
  onView: (mode) => {
    store.set({ view: mode });
    viewer.setView(mode);
  },
  onShowSwitch: (on) => {
    store.set({ showSwitch: on });
    viewer.showSwitch(on);
  },
  onSection: (axis, pos) => viewer.setSection(axis, pos),
  onExport: () => {
    if (latestParts.length) downloadThreeMF(latestParts, 'clicker.3mf');
  },
  onRenderPng: async () => {
    const blob = await viewer.renderToPng();
    if (blob) downloadBlob(blob, 'clicker-render.png');
  },
  onAiPrompt: async () => {
    try {
      await navigator.clipboard.writeText(AI_PROMPT);
      store.set({ status: 'AI image prompt copied to clipboard ✓' });
    } catch {
      store.set({ status: 'Could not copy — see console.' });
      console.log(AI_PROMPT);
    }
  },
  onSaveProject: () => saveProject(),
  onLoadProject: (file) => loadProject(file),
  onBodyColor: (hex) => {
    store.set({ bodyColorRgb: hexToRgb(hex) });
    debouncedRebuild();
  },

  onImportMode: (mode) => {
    store.set({ importMode: mode });
    if (mode !== 'image') {
      store.set({ colorMode: 'normal' });
    }
    reprocess();
  },
  onSvgUpload: async (file) => {
    try {
      store.set({ building: true, status: 'Reading SVG…' });
      const svgText = await file.text();
      ui.addUploadedSvg(svgText, file.name.replace(/\.svg$/i, ''));
      store.set({ building: false });
    } catch (err) {
      store.set({ building: false, status: 'Error reading SVG: ' + String(err) });
    }
  },
  onSelectSvg: (svgText, name) => {
    currentSvgText = svgText;
    currentSvgName = name;
    store.set({ status: `Selected SVG: ${name}. Click Generate to update.` });
  },
  onSelectIcon: (svgText, name) => {
    currentIconText = svgText;
    currentIconName = name;
    store.set({ currentIconName: name, status: `Selected icon: ${name}. Click Generate to update.` });
  },
  onTextChange: (text) => {
    currentText = text;
    store.set({ status: 'Text updated. Click Generate to update.' });
  },
  onFontSelect: (fontId) => {
    currentFontId = fontId;
    store.set({ status: 'Font changed. Click Generate to update.' });
  },
  onImportFont: async (file) => {
    try {
      store.set({ building: true, status: 'Importing font…' });
      const font = await importFontFile(file);
      ui.addFontOption(font);
      currentFontId = font.id;
      store.set({ building: false, status: `Font ${font.name} imported! Click Generate to update.` });
    } catch (err) {
      store.set({ building: false, status: 'Could not import font: ' + String(err) });
    }
  },
  onThemeChange: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('clicker-theme', theme);
    viewer.setTheme(theme);
  },
  onGenerate: () => {
    reprocess();
  },
});

store.subscribe((s) => ui.update(s));
ui.update(store.get());

// ---- Click a colored region on the 3D model to recolor it (live, no rebuild) ----
viewer.onPartPick((index, clientX, clientY) => {
  const part = latestParts[index];
  if (!part) {
    viewer.clearHighlight();
    return;
  }
  const target = partColorTarget(part.name);
  if (!target) {
    viewer.clearHighlight();
    return;
  }
  const s = store.get();
  const options: RGB[] =
    s.colorMode === 'limited' && s.limitedColors.length > 0
      ? s.limitedColors
      : FILAMENTS.map(([, hex]) => hexToRgb(hex));
  ui.showColorPopoverAt(clientX, clientY, rgbToHex(part.colorRgb), options, {
    onSelect: (hex) => applyModelRecolor(target, hexToRgb(hex), index),
    onClose: () => viewer.clearHighlight(),
  });
});

function partColorTarget(name: string): ColorTarget | null {
  if (name === 'base-body') return { kind: 'body' };
  if (name === 'top-base') return { kind: 'base' };
  const m = /^top-color-(\d+)$/.exec(name);
  return m ? { kind: 'region', index: +m[1] } : null;
}

// Apply a recolor to the clicked part: update the live material + export data, and
// persist into store state so it survives rebuilds. Geometry is identical for a
// color change, so we deliberately skip the worker rebuild.
function applyModelRecolor(target: ColorTarget, rgb: RGB, partIndex: number) {
  viewer.setPartColor(partIndex, rgb);
  if (latestParts[partIndex]) latestParts[partIndex] = { ...latestParts[partIndex], colorRgb: rgb };

  const s = store.get();
  if (target.kind === 'region') {
    const palette = s.palette.slice();
    if (palette[target.index]) palette[target.index] = { ...palette[target.index], filamentRgb: rgb };
    const overrides = s.paletteOverrides.slice();
    overrides[target.index] = rgb;
    store.set({ palette, paletteOverrides: overrides });
    syncBaseColor(); // the cap frame mirrors the dominant region — keep it in step
  } else if (target.kind === 'body') {
    store.set({ bodyColorRgb: rgb });
  } else {
    store.set({ baseColorOverride: rgb });
  }
}

// The cap backing/frame color is derived from the dominant region (unless the user
// pinned it). After a region recolor, repaint the frame part to match — live, no
// rebuild — so it never lags a frame behind the inlay it shares a color with.
function syncBaseColor() {
  const s = store.get();
  if (s.baseColorOverride || s.importMode === 'icon' || s.palette.length === 0) return;
  let domIdx = 0;
  for (let i = 1; i < s.palette.length; i++) {
    if (s.palette[i].coverage > s.palette[domIdx].coverage) domIdx = i;
  }
  const baseRgb = s.palette[domIdx]?.filamentRgb;
  if (!baseRgb) return;
  const bi = latestParts.findIndex((p) => p.name === 'top-base');
  if (bi >= 0) {
    latestParts[bi] = { ...latestParts[bi], colorRgb: baseRgb };
    viewer.setPartColor(bi, baseRgb);
  }
}

// Seed the SVG panel with bundled vector presets (added quietly, not selected).
(async function loadSvgSamples() {
  for (const sample of SVG_SAMPLES) {
    try {
      const svgText = await fetch(sample.src).then((r) => r.text());
      ui.addUploadedSvg(svgText, sample.name, false);
    } catch (err) {
      console.warn('Could not load SVG sample', sample.name, err);
    }
  }
})();

// ---- Geometry worker ----
const worker = new Worker(new URL('./workers/geometry.worker.ts', import.meta.url), {
  type: 'module',
});

worker.onmessage = (e: MessageEvent<GeometryResponse>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'ready':
      initAssets();
      break;
    case 'initDone':
      assetsReady = true;
      console.log('[assets] socket:', msg.socketInfo, '| stem:', msg.stemInfo, '| switch:', msg.switchInfo);
      viewer.setSwitch(msg.switchMesh);
      viewer.showSwitch(store.get().showSwitch);
      store.set({
        status: 'Ready — import an image, SVG, icon, or text.',
      });
      // Pick a default popular icon on startup so it builds immediately
      if (store.get().importMode === 'icon' && !currentIconText) {
        const first = LUCIDE_ICONS.find((ic) => ic.name === 'circle') || LUCIDE_ICONS[0];
        if (first) {
          currentIconText = buildSvg(first.node);
          currentIconName = first.name;
          store.set({ currentIconName: first.name });
        }
      }
      reprocess();
      break;
    case 'parts': {
      latestParts = msg.parts;
      viewer.setParts(msg.parts);
      viewer.setView(store.get().view);
      store.set({
        building: false,
        hasParts: msg.parts.length > 0,
        status: `Clicker ready ✓  ${msg.parts.length} parts. Orbit to inspect, then Download 3MF.`,
      });
      isInitialLoad = false;
      break;
    }
    case 'error':
      store.set({ building: false, status: 'Error: ' + firstLine(msg.message) });
      console.error('[geometry worker]', msg.message);
      isInitialLoad = false;
      break;
  }
};
worker.onerror = (e) => {
  store.set({ building: false, status: 'Worker failed: ' + e.message });
  console.error(e);
};

async function initAssets() {
  try {
    const base = import.meta.env.BASE_URL;
    const [socket, stem, sw] = await Promise.all([
      fetch(base + 'assets/switch/mx/mx-socket.3mf').then((r) => r.arrayBuffer()),
      fetch(base + 'assets/switch/mx/mx-stem.3mf').then((r) => r.arrayBuffer()),
      fetch(base + 'assets/switch/mx/mx-switch.3mf').then((r) => r.arrayBuffer()),
    ]);
    worker.postMessage({ type: 'init', socket, stem, switch: sw }, [socket, stem, sw]);
  } catch (err) {
    store.set({ status: 'Failed to load switch assets: ' + String(err) });
    isInitialLoad = false;
  }
}

// ---- Pipeline ----
async function openWizard(getter: () => Promise<RgbaImage>) {
  try {
    store.set({ building: true, status: 'Reading image…' });
    const baseImage = await getter();
    store.set({ building: false, status: 'Preprocess your image…' });
    runWizard({
      baseImage,
      initialColorCount: store.get().colorCount,
      onCancel: () =>
        store.set({ status: originalImage ? 'Ready.' : 'Ready — drop an image or try the sample.' }),
      onComplete: ({ adjusted, preprocess, colorCount, colorMode, limitedColors, paletteOverrides }) => {
        originalImage = adjusted;
        let defaultBodyColor = store.get().bodyColorRgb;
        if (colorMode === 'limited' && limitedColors && limitedColors.length > 0) {
          const blackHex = '#161616';
          const blackRgb = hexToRgb(blackHex);
          const hasBlack = limitedColors.some(c => c[0] === blackRgb[0] && c[1] === blackRgb[1] && c[2] === blackRgb[2]);
          defaultBodyColor = hasBlack ? blackRgb : limitedColors[0];
        }
        store.set({
          removeBg: !preprocess.keepBackground,
          colorCount,
          topThickness: Math.max(1, preprocess.thicknessMm),
          colorMode,
          limitedColors: limitedColors || [],
          bodyColorRgb: defaultBodyColor,
          paletteOverrides: paletteOverrides || [],
        });
        reprocess();
      },
    });
  } catch (err) {
    store.set({ building: false, status: 'Could not read image: ' + String(err) });
  }
}

function reprocess() {
  // A fresh trace means fresh regions — drop any pinned frame color so it re-derives.
  store.set({ baseColorOverride: null });
  const s = store.get();

  if (s.importMode === 'image') {
    if (!originalImage) return;
    store.set({ building: true, status: 'Removing background & tracing…' });
    regionSet = processImage(cloneImage(originalImage), s.colorCount, {
      removeBg: s.removeBg,
      smoothing: s.smoothing,
      customColors: s.colorMode === 'limited' ? s.limitedColors : undefined,
    });
  } else if (s.importMode === 'svg') {
    if (!currentSvgText) {
      store.set({ status: 'Upload an SVG file first.' });
      return;
    }
    try {
      store.set({ building: true, status: 'Parsing SVG…' });
      regionSet = parseSvg(currentSvgText);
    } catch (e: any) {
      store.set({ building: false, status: 'Error: ' + e.message });
      return;
    }
  } else if (s.importMode === 'icon') {
    if (!currentIconText) {
      const first = LUCIDE_ICONS.find((ic) => ic.name === 'circle') || LUCIDE_ICONS[0];
      if (first) {
        currentIconText = buildSvg(first.node);
        currentIconName = first.name;
        store.set({ currentIconName: first.name });
      }
    }
    if (!currentIconText) {
      store.set({ status: 'Select an icon first.' });
      return;
    }
    try {
      store.set({ building: true, status: 'Parsing Icon…' });
      regionSet = parseSvg(currentIconText);
    } catch (e: any) {
      store.set({ building: false, status: 'Error: ' + e.message });
      return;
    }
  } else if (s.importMode === 'text') {
    try {
      store.set({ building: true, status: 'Generating Text…' });
      regionSet = parseLetter(currentText, currentFontId, 8);
    } catch (e: any) {
      store.set({ building: false, status: 'Error: ' + e.message });
      return;
    }
  }

  if (!regionSet) return;

  const palette: PaletteEntry[] = regionSet.regions.map((r, i) => ({
    quantRgb: r.quantRgb,
    filamentRgb: s.paletteOverrides[i] ?? r.quantRgb,
    coverage: r.coverage,
    heightLevel: 0,
  }));
  store.set({ palette });

  if (palette.length === 0) {
    store.set({ building: false, status: 'No outline found.' });
    return;
  }
  rebuild();
}

function rebuild() {
  if (!regionSet || regionSet.regions.length === 0) return;
  if (!assetsReady) {
    store.set({ status: 'Waiting for switch assets…' });
    return;
  }
  const s = store.get();

  // Dominant color carries the slab + stem (the base filament).
  let domIdx = 0;
  for (let i = 1; i < s.palette.length; i++) {
    if (s.palette[i].coverage > s.palette[domIdx].coverage) domIdx = i;
  }

  const regions: BuildRegion[] = regionSet.regions.map((r, i) => ({
    filamentRgb: s.palette[i]?.filamentRgb ?? r.quantRgb,
    heightLevel: s.palette[i]?.heightLevel ?? 0,
    coverage: r.coverage,
    rings: r.rings,
  }));

  // Icons are line-art (a single-color silhouette), not a multi-color picture.
  // Using their thin stroke as the body outline makes a broken ring, so the body
  // is always a solid shape (circle/square) and the icon rides on top as a design.
  // The cap base then needs a background distinct from the dark icon ink.
  const isIcon = s.importMode === 'icon';
  const effectiveBaseShape = isIcon && s.baseShape === 'outline' ? 'circle' : s.baseShape;
  const defaultBaseColor: RGB = isIcon
    ? ([240, 240, 240] as RGB)
    : (s.palette[domIdx]?.filamentRgb ?? ([180, 180, 185] as RGB));
  // A frame color the user pinned by clicking it on the model wins over the derived one.
  const capBaseColor: RGB = s.baseColorOverride ?? defaultBaseColor;

  const params: BuildParams = {
    baseShape: effectiveBaseShape,
    capWidthMm: s.capWidthMm,
    topThickness: Math.max(1, s.topThickness),
    imageDepth: s.imageDepth,
    imageMargin: 1.2,
    borderWidth: 2.6,
    capProud: 4.0,
    tolerance: s.tolerance,
    colorBleed: 0.12,
    stepHeight: 0.6,
    travel: 4.0,
    floorThickness: 1.6,
    keychainHole: s.keychain,
    baseFilamentRgb: capBaseColor,
    bodyColorRgb: s.bodyColorRgb ?? ([120, 124, 130] as RGB),
  };

  if (isInitialLoad) {
    store.set({ status: 'Building clicker…' });
  } else {
    store.set({ building: true, status: 'Building clicker…' });
  }
  worker.postMessage({ type: 'buildClicker', regions, outline: regionSet.outline, params });
}

// ---- Debounce ----
function debounce(fn: () => void, ms: number) {
  let t = 0;
  return () => {
    clearTimeout(t);
    t = window.setTimeout(fn, ms);
  };
}
const debouncedRebuild = debounce(rebuild, 130);
const debouncedReprocess = debounce(reprocess, 220);

function hexToRgb(hex: string): RGB {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
function rgbToHex(rgb: RGB): string {
  return (
    '#' +
    rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
  );
}
function firstLine(s: string): string {
  return s.split('\n')[0];
}

// ---- Render / project save-load / AI prompt ----
function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function imageToDataUrl(img: RgbaImage): string {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c.toDataURL('image/png');
}

function dataUrlToImage(url: string): Promise<RgbaImage> {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height);
      resolve({ data: d.data, width: c.width, height: c.height });
    };
    im.onerror = () => reject(new Error('bad image data'));
    im.src = url;
  });
}

function saveProject() {
  const s = store.get();
  const proj = {
    version: 2,
    settings: {
      colorCount: s.colorCount,
      baseShape: s.baseShape,
      capWidthMm: s.capWidthMm,
      topThickness: s.topThickness,
      imageDepth: s.imageDepth,
      tolerance: s.tolerance,
      smoothing: s.smoothing,
      removeBg: s.removeBg,
      importMode: s.importMode,
      currentText,
      currentFontId,
      currentSvgText,
      currentSvgName,
      currentIconText,
      currentIconName,
      colorMode: s.colorMode,
      limitedColors: s.limitedColors,
      bodyColorRgb: s.bodyColorRgb,
      paletteOverrides: s.paletteOverrides,
      baseColorOverride: s.baseColorOverride,
    },
    palette: s.palette, // filament mappings + height levels
    image: originalImage ? imageToDataUrl(originalImage) : null,
  };
  downloadBlob(new Blob([JSON.stringify(proj)], { type: 'application/json' }), 'clicker-project.json');
  store.set({ status: 'Project saved ✓' });
}

async function loadProject(file: File) {
  try {
    store.set({ building: true, status: 'Loading project…' });
    const proj = JSON.parse(await file.text());
    const set = proj.settings ?? {};

    currentText = set.currentText ?? 'A';
    currentFontId = set.currentFontId ?? 'helvetiker-regular';
    currentSvgText = set.currentSvgText ?? '';
    currentSvgName = set.currentSvgName ?? '';
    currentIconText = set.currentIconText ?? '';
    currentIconName = set.currentIconName ?? '';

    if (currentSvgText && currentSvgName) {
      ui.addUploadedSvg(currentSvgText, currentSvgName);
    }

    store.set({
      importMode: set.importMode ?? 'image',
      colorCount: set.colorCount ?? store.get().colorCount,
      baseShape: set.baseShape ?? store.get().baseShape,
      capWidthMm: set.capWidthMm ?? store.get().capWidthMm,
      topThickness: set.topThickness ?? store.get().topThickness,
      imageDepth: set.imageDepth ?? store.get().imageDepth,
      tolerance: set.tolerance ?? store.get().tolerance,
      smoothing: set.smoothing ?? store.get().smoothing,
      removeBg: set.removeBg ?? store.get().removeBg,
      currentIconName: currentIconName || 'circle',
      colorMode: set.colorMode ?? 'normal',
      limitedColors: set.limitedColors ?? [],
      bodyColorRgb: set.bodyColorRgb ?? [120, 124, 130],
      paletteOverrides: set.paletteOverrides ?? [],
    });

    if (set.importMode === 'image' && proj.image) {
      originalImage = await dataUrlToImage(proj.image);
    }

    reprocess();

    if (Array.isArray(proj.palette)) {
      const pal = store.get().palette.map((p, i) => ({
        ...p,
        filamentRgb: proj.palette[i]?.filamentRgb ?? p.filamentRgb,
        heightLevel: proj.palette[i]?.heightLevel ?? p.heightLevel,
      }));
      store.set({ palette: pal, baseColorOverride: set.baseColorOverride ?? null });
      rebuild();
    }
  } catch (err) {
    store.set({ building: false, status: 'Could not load project: ' + String(err) });
  }
}

const AI_PROMPT = [
  'Create a simple, flat vector-style illustration suitable for a small multi-color 3D print.',
  'Requirements:',
  '- Bold, clean shapes with thick outlines; no gradients, no shading, no texture.',
  '- A small number of FLAT solid colors (4–6 max), each clearly separated.',
  '- Centered subject on a plain solid (or transparent) background.',
  '- High contrast between adjacent colors; avoid thin slivers and tiny details.',
  '- Square-ish framing, subject fills ~80% of the canvas.',
  'Subject: <describe your subject here>.',
].join('\n');
