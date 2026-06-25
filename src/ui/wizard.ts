// Bambu-style image → model wizard. Three modal steps:
//   1) Preprocessing  — crop ratio, keep background, thickness, tone/color sliders
//   2) Conversion preview — shows the processed (matte-applied) result
//   3) Auto matching  — pick 4 / 8 / 12 colors, preview the color→slot mapping
// On confirm it hands the adjusted image (background intact) + params back; the
// caller runs the trace/build pipeline (background removal is re-derived there).
import type { RgbaImage } from '../image/decode';
import { preprocessImage } from '../image/adjust';
import { removeBackground } from '../image/matte';
import { quantize, type QuantizeResult } from '../image/quantize';
import { DEFAULT_PREPROCESS, FILAMENTS, type CropRatio, type PreprocessParams, type RGB } from '../types';

export interface WizardResult {
  adjusted: RgbaImage; // cropped + tone-adjusted, background still present
  preprocess: PreprocessParams;
  colorCount: number;
  colorMode: 'normal' | 'limited';
  limitedColors?: RGB[];
  paletteOverrides?: RGB[];
}

interface WizardOpts {
  baseImage: RgbaImage;
  initialColorCount: number;
  onComplete(result: WizardResult): void;
  onCancel?(): void;
}

const SLIDERS: [keyof PreprocessParams, string][] = [
  ['exposure', 'Exposure'],
  ['contrast', 'Contrast'],
  ['saturation', 'Saturation'],
  ['brightness', 'Brightness'],
  ['whiteBalance', 'White Balance'],
  ['highlights', 'Highlights'],
  ['shadows', 'Shadows'],
];

const RATIOS: [CropRatio, string][] = [
  ['free', 'Free'],
  ['1:1', '1:1'],
  ['4:3', '4:3'],
  ['3:2', '3:2'],
  ['16:9', '16:9'],
];

function imageToCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

export function runWizard(opts: WizardOpts) {
  const params: PreprocessParams = { ...DEFAULT_PREPROCESS };
  let colorCount = [4, 8, 12].includes(opts.initialColorCount) ? opts.initialColorCount : 4;
  let colorMode: 'normal' | 'limited' = 'normal';
  let limitedColors: RGB[] = [];
  let wizardPaletteOverrides: RGB[] = [];

  const overlay = document.createElement('div');
  overlay.className = 'wz-overlay';
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const cancel = () => {
    close();
    opts.onCancel?.();
  };

  // Adjusted image (background intact) for the current params.
  const adjusted = () => preprocessImage(opts.baseImage, params);
  // Processed image used for preview / matching (background removed unless kept).
  const processed = (): RgbaImage => {
    const a = adjusted();
    if (!params.keepBackground) removeBackground(a);
    return a;
  };

  function hexRgb(hex: string): RGB {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  function getQuantizedImage(img: RgbaImage, q: QuantizeResult, overrides: RGB[], highlightedIdx: number | null = null): RgbaImage {
    const data = new Uint8ClampedArray(img.width * img.height * 4);
    for (let i = 0; i < q.indices.length; i++) {
      const idx = q.indices[i];
      if (idx === -1) {
        data[i * 4] = 0;
        data[i * 4 + 1] = 0;
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 0;
      } else {
        const rgb = overrides[idx] || q.palette[idx].rgb;
        if (highlightedIdx !== null && idx !== highlightedIdx) {
          // Dim other colors by 65%
          data[i * 4] = Math.round(rgb[0] * 0.35);
          data[i * 4 + 1] = Math.round(rgb[1] * 0.35);
          data[i * 4 + 2] = Math.round(rgb[2] * 0.35);
        } else {
          data[i * 4] = rgb[0];
          data[i * 4 + 1] = rgb[1];
          data[i * 4 + 2] = rgb[2];
        }
        data[i * 4 + 3] = 255;
      }
    }
    return { data, width: img.width, height: img.height };
  }

  function rgbHex(rgb: RGB): string {
    return '#' + rgb.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }

  // ---------- Step 0: color mode selection ----------
  function stepChooseColorMode() {
    overlay.innerHTML = `
      <div class="wz-modal" style="max-width: 480px; width: 90vw;">
        <div class="wz-head" style="text-align: center;">Color Generation Mode</div>
        <div class="wz-body col" style="gap: 20px; padding: 25px 30px;">
          <div class="wz-sub" style="text-align: center; font-size: 15px; margin-bottom: 5px;">
            Choose how you want to handle the colors for your 3D printed clicker:
          </div>
          
          <button class="mode-select-btn" id="modeNormal" style="display: flex; flex-direction: column; align-items: flex-start; text-align: left; padding: 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-2); width: 100%; cursor: pointer; transition: all 0.15s ease; border-style: solid;">
            <strong style="font-size: 16px; color: var(--text); margin-bottom: 6px;">Generate Normally</strong>
            <span style="font-size: 13px; color: var(--muted); line-height: 1.4;">
              Automatically extracts colors from the image (median-cut). You can map them to filaments later.
            </span>
          </button>
          
          <button class="mode-select-btn" id="modeLimited" style="display: flex; flex-direction: column; align-items: flex-start; text-align: left; padding: 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-2); width: 100%; cursor: pointer; transition: all 0.15s ease; border-style: solid;">
            <strong style="font-size: 16px; color: var(--text); margin-bottom: 6px;">Use Limited Colors</strong>
            <span style="font-size: 13px; color: var(--muted); line-height: 1.4;">
              Choose the colors of the filament you have available, so we generate the image using <strong>just</strong> the colors that you have and can print in.
            </span>
          </button>
        </div>
        <div class="wz-foot" style="justify-content: center;">
          <button id="wzCancel" style="min-width: 120px;">Cancel</button>
        </div>
      </div>`;

    const btnNormal = overlay.querySelector('#modeNormal')!;
    const btnLimited = overlay.querySelector('#modeLimited')!;
    
    const addEffects = (btn: HTMLElement) => {
      btn.addEventListener('mouseenter', () => {
        btn.style.borderColor = 'var(--accent)';
        btn.style.transform = 'translateY(-1px)';
        btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.borderColor = 'var(--line)';
        btn.style.transform = 'none';
        btn.style.boxShadow = 'none';
      });
    };
    addEffects(btnNormal as HTMLElement);
    addEffects(btnLimited as HTMLElement);

    btnNormal.addEventListener('click', () => {
      colorMode = 'normal';
      stepPreprocess();
    });

    btnLimited.addEventListener('click', () => {
      colorMode = 'limited';
      stepLimitedColorPicker();
    });

    overlay.querySelector('#wzCancel')!.addEventListener('click', cancel);
  }

  // ---------- Step 0.5: limited color picker ----------
  function stepLimitedColorPicker() {
    overlay.innerHTML = `
      <div class="wz-modal" style="max-width: 500px; width: 90vw;">
        <div class="wz-head">Select Available Filaments</div>
        <div class="wz-body col" style="gap: 15px;">
          <div class="wz-sub" style="font-size: 14px; text-align: left; width: 100%;">
            Choose the colors of the filament you have available. We will generate the image using <strong>just</strong> the colors that you have and can print in.
          </div>
          
          <div style="font-size: 13px; font-weight: 600; width: 100%; display: flex; justify-content: space-between;">
            <span>Select 2 to 12 colors:</span>
            <span id="wzSelCount">0 selected</span>
          </div>
          
          <div class="wz-filament-grid" id="wzFilGrid" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; width: 100%; margin: 10px 0;">
            ${FILAMENTS.map(([name, hex], i) => `
              <button class="wz-fil-btn" data-idx="${i}" data-hex="${hex}" type="button" style="display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 5px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); cursor: pointer; transition: all 0.12s; border-style: solid;">
                <span style="display: block; width: 24px; height: 24px; border-radius: 50%; background: ${hex}; border: 1px solid rgba(0,0,0,0.15);"></span>
                <span style="font-size: 11px; color: var(--text); font-weight: 500; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;">${name}</span>
              </button>
            `).join('')}
          </div>
        </div>
        <div class="wz-foot">
          <button id="wzBackMode">Back</button>
          <button class="primary" id="wzNextMode" disabled>Next</button>
        </div>
      </div>`;

    const btns = overlay.querySelectorAll<HTMLButtonElement>('.wz-fil-btn');
    const selectedIndices = new Set<number>();
    const countEl = overlay.querySelector('#wzSelCount')!;
    const nextBtn = overlay.querySelector<HTMLButtonElement>('#wzNextMode')!;

    const updateSelection = () => {
      countEl.textContent = `${selectedIndices.size} selected`;
      if (selectedIndices.size >= 2 && selectedIndices.size <= 12) {
        nextBtn.disabled = false;
        nextBtn.style.opacity = '1';
      } else {
        nextBtn.disabled = true;
        nextBtn.style.opacity = '0.5';
      }
      
      btns.forEach((btn, idx) => {
        const isSelected = selectedIndices.has(idx);
        btn.style.borderColor = isSelected ? 'var(--accent)' : 'var(--line)';
        btn.style.background = isSelected ? 'rgba(142, 68, 173, 0.1)' : 'var(--panel-2)';
        btn.style.borderWidth = isSelected ? '2px' : '1px';
      });
    };

    btns.forEach((btn) => {
      const idx = parseInt(btn.dataset.idx!);
      btn.addEventListener('click', () => {
        if (selectedIndices.has(idx)) {
          selectedIndices.delete(idx);
        } else {
          if (selectedIndices.size < 12) {
            selectedIndices.add(idx);
          }
        }
        updateSelection();
      });
    });

    overlay.querySelector('#wzBackMode')!.addEventListener('click', stepChooseColorMode);
    nextBtn.addEventListener('click', () => {
      limitedColors = Array.from(selectedIndices).map(idx => hexRgb(FILAMENTS[idx][1]));
      stepPreprocess();
    });

    updateSelection();
  }

  // ---------- Step 1: preprocessing ----------
  function stepPreprocess() {
    overlay.innerHTML = `
      <div class="wz-modal lg">
        <div class="wz-head">Image Preprocessing</div>
        <div class="wz-body">
          <div class="wz-canvas checker" id="wzPrev"></div>
          <div class="wz-controls">
            <div class="wz-label">Crop Ratio</div>
            <div class="seg" id="wzRatio">${RATIOS.map(
              ([k, l]) => `<button data-r="${k}">${l}</button>`,
            ).join('')}</div>

            <div class="wz-row spread">
              <span class="wz-label">Keep Background</span>
              <label class="toggle"><input type="checkbox" id="wzKeep" /><span class="track"></span></label>
            </div>

            <div class="wz-row spread">
              <span class="wz-label">Image Thickness</span>
              <span class="wz-num"><input type="number" id="wzThick" min="0.2" max="10" step="0.2" /> mm</span>
            </div>

            <div class="wz-label">Image Adjustment</div>
            ${SLIDERS.map(
              ([k, l]) => `
              <div class="wz-adj">
                <span>${l}</span>
                <input type="range" data-k="${k}" min="0" max="2" step="0.05" />
                <span class="wz-num"><input type="number" data-n="${k}" min="0" max="2" step="0.05" /></span>
              </div>`,
            ).join('')}
          </div>
        </div>
        <div class="wz-foot">
          <button id="wzBack">← Back</button>
          <button class="primary" id="wzNext">Next</button>
        </div>
      </div>`;

    const prev = overlay.querySelector<HTMLElement>('#wzPrev')!;
    const redraw = () => {
      prev.innerHTML = '';
      const adj = adjusted();
      let displayImg = adj;
      if (colorMode === 'limited' && limitedColors.length > 0) {
        const tempImg = { data: new Uint8ClampedArray(adj.data), width: adj.width, height: adj.height };
        if (!params.keepBackground) removeBackground(tempImg);
        const q = quantize(tempImg, limitedColors.length, limitedColors);
        if (wizardPaletteOverrides.length !== q.palette.length) {
          wizardPaletteOverrides = q.palette.map(p => p.rgb);
        }
        displayImg = getQuantizedImage(tempImg, q, wizardPaletteOverrides);
      }
      prev.appendChild(imageToCanvas(displayImg));
    };
    redraw();

    for (const b of overlay.querySelectorAll<HTMLElement>('#wzRatio button')) {
      b.classList.toggle('active', b.dataset.r === params.cropRatio);
      b.addEventListener('click', () => {
        params.cropRatio = b.dataset.r as CropRatio;
        for (const x of overlay.querySelectorAll('#wzRatio button')) x.classList.remove('active');
        b.classList.add('active');
        redraw();
      });
    }

    const keep = overlay.querySelector<HTMLInputElement>('#wzKeep')!;
    keep.checked = params.keepBackground;
    keep.addEventListener('change', () => (params.keepBackground = keep.checked));

    const thick = overlay.querySelector<HTMLInputElement>('#wzThick')!;
    thick.value = String(params.thicknessMm);
    thick.addEventListener('input', () => (params.thicknessMm = +thick.value || 1));

    let raf = 0;
    const scheduleRedraw = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(redraw);
    };
    for (const [k] of SLIDERS) {
      const range = overlay.querySelector<HTMLInputElement>(`input[data-k="${k}"]`)!;
      const num = overlay.querySelector<HTMLInputElement>(`input[data-n="${k}"]`)!;
      range.value = num.value = String(params[k]);
      const apply = (v: number) => {
        (params[k] as number) = v;
        range.value = num.value = String(v);
        scheduleRedraw();
      };
      range.addEventListener('input', () => apply(+range.value));
      num.addEventListener('input', () => apply(+num.value));
    }

    overlay.querySelector('#wzBack')!.addEventListener('click', () => {
      if (colorMode === 'limited') {
        stepLimitedColorPicker();
      } else {
        stepChooseColorMode();
      }
    });
    overlay.querySelector('#wzNext')!.addEventListener('click', stepRecolor);
  }

  // Floating swatch picker anchored at a viewport point (cursor or trigger corner),
  // then measured and clamped so it never lands off-screen / in the top-left corner.
  function showWizardColorPickerAt(
    clientX: number,
    clientY: number,
    currentHex: string,
    onSelect: (hex: string) => void
  ) {
    document.getElementById('wzColorPopover')?.remove();

    const popover = document.createElement('div');
    popover.id = 'wzColorPopover';
    popover.className = 'color-popover';
    document.body.appendChild(popover);

    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      popover.remove();
      document.removeEventListener('mousedown', dismiss);
    };

    const options = colorMode === 'limited' ? limitedColors : FILAMENTS.map((f) => hexRgb(f[1]));
    options.forEach((rgb) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.background = rgbHex(rgb);
      if (rgbHex(rgb).toLowerCase() === currentHex.toLowerCase()) btn.classList.add('active');
      btn.addEventListener('click', () => {
        onSelect(rgbHex(rgb));
        close();
      });
      popover.appendChild(btn);
    });

    const custom = document.createElement('label');
    custom.className = 'cp-custom';
    custom.title = 'Custom color';
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = /^#[0-9a-f]{6}$/i.test(currentHex) ? currentHex : '#888888';
    inp.addEventListener('input', () => onSelect(inp.value));
    custom.appendChild(inp);
    popover.appendChild(custom);

    const w = popover.offsetWidth || 170;
    const h = popover.offsetHeight || 180;
    popover.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - w - 8))}px`;
    popover.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - h - 8))}px`;

    const dismiss = (e: MouseEvent) => {
      if (!popover.contains(e.target as Node)) close();
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss), 50);
  }

  function showWizardColorPicker(
    triggerEl: HTMLElement,
    currentHex: string,
    onSelect: (hex: string) => void
  ) {
    const rect = triggerEl.getBoundingClientRect();
    showWizardColorPickerAt(rect.left, rect.bottom + 6, currentHex, onSelect);
  }

  // ---------- Step 2: Recolor & Customize ----------
  function stepRecolor() {
    const proc = processed();
    let q: QuantizeResult;
    
    const runQuantize = () => {
      if (colorMode === 'limited') {
        q = quantize({ data: new Uint8ClampedArray(proc.data), width: proc.width, height: proc.height }, limitedColors.length, limitedColors);
      } else {
        q = quantize({ data: new Uint8ClampedArray(proc.data), width: proc.width, height: proc.height }, colorCount);
      }
      if (wizardPaletteOverrides.length !== q.palette.length) {
        wizardPaletteOverrides = q.palette.map(p => p.rgb);
      }
    };
    
    runQuantize();

    let activeColorIdx = 0;
    let hoveredColorIdx: number | null = null;

    overlay.innerHTML = `
      <div class="wz-modal recolor">
        <div class="wz-head">${colorMode === 'limited' ? 'Filament Customization (Limited Colors)' : 'Filament Customization'}</div>
        <div class="wz-body">
          <div class="wz-sidebar">
            ${colorMode === 'normal' ? `
              <div class="wz-section">
                <div class="wz-label">Color Count</div>
                <div class="seg" id="wzCount" style="margin-bottom: 4px;">
                  ${[4, 8, 12].map((n) => `<button data-n="${n}">${n} Color</button>`).join('')}
                </div>
              </div>
            ` : ''}

            <div class="wz-section" style="flex-grow: 1;">
              <div class="wz-label">Color Slots</div>
              <div class="wz-slots" id="wzSlots"></div>
            </div>
          </div>
          <div class="wz-preview-area">
            <div class="wz-canvas checker" id="wzPrevCanvas"></div>
            <div class="wz-sub">Hover regions to highlight. Click a region or click a slot's swatch to change its color.</div>
          </div>
        </div>
        <div class="wz-foot">
          <button id="wzBack">← Back</button>
          <button class="primary" id="wzDone">Confirm</button>
        </div>
      </div>`;

    const canvasContainer = overlay.querySelector('#wzPrevCanvas')!;
    const slotsContainer = overlay.querySelector('#wzSlots')!;

    function drawCanvas() {
      canvasContainer.innerHTML = '';
      const highlightIdx = hoveredColorIdx !== null ? hoveredColorIdx : activeColorIdx;
      const displayImg = getQuantizedImage(proc, q, wizardPaletteOverrides, highlightIdx);
      const canvas = imageToCanvas(displayImg);
      canvasContainer.appendChild(canvas);

      canvas.style.cursor = 'pointer';
      canvas.title = 'Click a region to customize its color';

      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        
        const imgX = Math.floor((clickX / rect.width) * proc.width);
        const imgY = Math.floor((clickY / rect.height) * proc.height);
        
        let newHoverIdx: number | null = null;
        if (imgX >= 0 && imgX < proc.width && imgY >= 0 && imgY < proc.height) {
          const pixelIdx = imgY * proc.width + imgX;
          const colorIdx = q.indices[pixelIdx];
          if (colorIdx !== -1) {
            newHoverIdx = colorIdx;
          }
        }
        
        if (newHoverIdx !== hoveredColorIdx) {
          hoveredColorIdx = newHoverIdx;
          drawCanvas();
          updateRowHighlights();
        }
      });

      canvas.addEventListener('mouseleave', () => {
        if (hoveredColorIdx !== null) {
          hoveredColorIdx = null;
          drawCanvas();
          updateRowHighlights();
        }
      });

      canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        
        const imgX = Math.floor((clickX / rect.width) * proc.width);
        const imgY = Math.floor((clickY / rect.height) * proc.height);
        
        if (imgX >= 0 && imgX < proc.width && imgY >= 0 && imgY < proc.height) {
          const pixelIdx = imgY * proc.width + imgX;
          const colorIdx = q.indices[pixelIdx];
          if (colorIdx !== -1) {
            activeColorIdx = colorIdx;
            drawCanvas();
            renderSlots();

            const currentHex = rgbHex(wizardPaletteOverrides[colorIdx] || q.palette[colorIdx].rgb);
            showWizardColorPickerAt(e.clientX, e.clientY, currentHex, (hex) => {
              wizardPaletteOverrides[colorIdx] = hexRgb(hex);
              drawCanvas();
              renderSlots();
            });
          }
        }
      });
    }

    function renderSlots() {
      slotsContainer.innerHTML = '';
      q.palette.forEach((entry, i) => {
        const row = document.createElement('div');
        row.className = `wz-slot-row${i === activeColorIdx ? ' active' : ''}`;
        row.dataset.idx = String(i);
        
        const currentMappedRgb = wizardPaletteOverrides[i] || entry.rgb;
        const mappedHex = rgbHex(currentMappedRgb);
        const sourceHex = rgbHex(entry.rgb);

        row.innerHTML = `
          <span class="dot-original" style="background: ${sourceHex}"></span>
          <span class="slot-arrow">→</span>
          <button type="button" class="dot-mapped" style="background: ${mappedHex}"></button>
          <span class="slot-name">Slot ${i + 1}</span>
          <span class="slot-pct">${Math.round(entry.coverage * 100)}%</span>
        `;

        row.addEventListener('mouseenter', () => {
          hoveredColorIdx = i;
          drawCanvas();
          updateRowHighlights();
        });

        row.addEventListener('mouseleave', () => {
          if (hoveredColorIdx === i) {
            hoveredColorIdx = null;
            drawCanvas();
            updateRowHighlights();
          }
        });

        row.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('.dot-mapped')) {
            e.stopPropagation();
            activeColorIdx = i;
            renderSlots();
            drawCanvas();
            
            const dotBtn = row.querySelector('.dot-mapped')!;
            showWizardColorPicker(dotBtn as HTMLElement, mappedHex, (hex) => {
              wizardPaletteOverrides[i] = hexRgb(hex);
              renderSlots();
              drawCanvas();
            });
          } else {
            activeColorIdx = i;
            renderSlots();
            drawCanvas();
          }
        });

        slotsContainer.appendChild(row);
      });
    }

    function updateRowHighlights() {
      const rows = slotsContainer.querySelectorAll('.wz-slot-row');
      rows.forEach((r, i) => {
        const hoverHighlight = hoveredColorIdx === i;
        const activeHighlight = activeColorIdx === i;
        r.classList.toggle('active', activeHighlight);
        const rEl = r as HTMLElement;
        if (hoverHighlight) {
          rEl.style.borderColor = 'var(--accent)';
          rEl.style.background = 'rgba(255, 255, 255, 0.05)';
        } else {
          rEl.style.borderColor = activeHighlight ? 'var(--accent)' : 'var(--line)';
          rEl.style.background = activeHighlight ? 'rgba(142, 68, 173, 0.1)' : 'var(--panel-2)';
        }
      });
    }

    if (colorMode === 'normal') {
      for (const b of overlay.querySelectorAll<HTMLElement>('#wzCount button')) {
        b.classList.toggle('active', +b.dataset.n! === colorCount);
        b.addEventListener('click', () => {
          colorCount = +b.dataset.n!;
          for (const x of overlay.querySelectorAll('#wzCount button')) x.classList.remove('active');
          b.classList.add('active');
          
          runQuantize();
          activeColorIdx = 0;
          hoveredColorIdx = null;
          
          renderSlots();
          drawCanvas();
        });
      }
    }

    overlay.querySelector('#wzBack')!.addEventListener('click', () => {
      stepPreprocess();
    });

    overlay.querySelector('#wzDone')!.addEventListener('click', () => {
      close();
      opts.onComplete({
        adjusted: adjusted(),
        preprocess: { ...params },
        colorCount: colorMode === 'limited' ? limitedColors.length : colorCount,
        colorMode,
        limitedColors: colorMode === 'limited' ? limitedColors : undefined,
        paletteOverrides: wizardPaletteOverrides,
      });
    });

    renderSlots();
    drawCanvas();
  }

  stepChooseColorMode();
}
