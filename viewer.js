// viewer.js

// ARC INTERPOLATION
function interpolateArc(x0, y0, x1, y1, i, j, clockwise, segments = 30) {
  const cx = x0 + i;
  const cy = y0 + j;
  let startAngle = Math.atan2(y0 - cy, x0 - cx);
  let endAngle = Math.atan2(y1 - cy, x1 - cx);

  if (clockwise) {
    if (endAngle > startAngle) endAngle -= 2 * Math.PI;
  } else {
    if (endAngle < startAngle) endAngle += 2 * Math.PI;
  }

  const angles = Array.from({ length: segments }, (_, i) =>
    startAngle + (i * (endAngle - startAngle)) / (segments - 1)
  );
  const radius = Math.hypot(i, j);
  const arcPoints = angles.map(a => [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);

  return arcPoints.slice(0, -1).map((p, idx) => [p, arcPoints[idx + 1]]);
}

function parseGCode(gcodeText, targetLayerZ = 0.2, zTolerance = 0.01) {
  const lines = gcodeText.split('\n');
  const firstLayerMoves = {};
  let currentZ = null;
  let recording = false;
  let xPrev = null, yPrev = null;
  let currentType = 'unknown';
  let startedObject = false;

  // Map both PrusaSlicer and OrcaSlicer feature/type comments to internal types
  const featureTypeMap = {
    // PrusaSlicer
    'perimeter': 'perimeter',
    'external perimeter': 'external perimeter',
    'infill': 'infill',
    'internal infill': 'infill',
    'solid infill': 'solid infill',
    // OrcaSlicer
    'inner wall': 'perimeter',
    'outer wall': 'external perimeter',
    'infill': 'infill',
    'solid infill': 'solid infill',
    'bottom surface': 'solid infill',
    'gap infill': 'solid infill',
    // fallback
    'unknown': 'unknown'
  };

  for (let line of lines) {
    line = line.trim();

    // Start after either "; start printing object" (OrcaSlicer) or ";LAYER_CHANGE" (PrusaSlicer)
    if (!startedObject && (/^; *start printing object/i.test(line) || /^;LAYER_CHANGE/i.test(line))) {
      startedObject = true;
      continue;
    }
    if (!startedObject) continue;

    // PrusaSlicer: ;TYPE:Perimeter
    if (/^;TYPE:/i.test(line)) {
      const type = line.slice(6).trim().toLowerCase();
      currentType = featureTypeMap[type] || 'unknown';
      continue;
    }

    // OrcaSlicer: ; FEATURE: Inner wall
    if (/^; ?FEATURE:/i.test(line)) {
      const match = line.match(/^; ?FEATURE:\s*(.+)$/i);
      if (match) {
        const type = match[1].trim().toLowerCase();
        currentType = featureTypeMap[type] || 'unknown';
        continue;
      }
    }

    if (line.startsWith(';')) continue;

    const cmd = line.split(/\s+/)[0];
    if (!['G0', 'G1', 'G2', 'G3'].includes(cmd)) continue;

    const zMatch = line.match(/Z([-+]?\d*\.?\d+)/);
    if (zMatch) {
      currentZ = parseFloat(zMatch[1]);
      recording = Math.abs(currentZ - targetLayerZ) <= zTolerance;
    }

    const xMatch = line.match(/X([-+]?\d*\.?\d+)/);
    const yMatch = line.match(/Y([-+]?\d*\.?\d+)/);
    const eMatch = line.match(/E([-+]?\d*\.?\d+)/);
    const iMatch = line.match(/I([-+]?\d*\.?\d+)/);
    const jMatch = line.match(/J([-+]?\d*\.?\d+)/);

    const hasX = !!xMatch;
    const hasY = !!yMatch;
    const hasE = !!eMatch;
    const x = hasX ? parseFloat(xMatch[1]) : xPrev;
    const y = hasY ? parseFloat(yMatch[1]) : yPrev;
    const hasXY = x !== null && y !== null;

    // Skip pure E moves (e.g., retractions/de-retractions)
    if (!hasX && !hasY && hasE) continue;

    // Start recording when Z is at the first layer height
    if (currentZ !== null && Math.abs(currentZ - targetLayerZ) <= zTolerance) {
      recording = true;
    } else {
      recording = false;
    }

    if (recording && hasXY && hasE && xPrev !== null && yPrev !== null) {
      if (!firstLayerMoves[currentType]) firstLayerMoves[currentType] = [];

      if ((cmd === 'G2' || cmd === 'G3') && iMatch && jMatch) {
        const i = parseFloat(iMatch[1]);
        const j = parseFloat(jMatch[1]);
        const clockwise = cmd === 'G2';
        const arcSegments = interpolateArc(xPrev, yPrev, x, y, i, j, clockwise);
        firstLayerMoves[currentType].push(...arcSegments);
      } else {
        firstLayerMoves[currentType].push([[xPrev, yPrev], [x, y]]);
      }
    }

    xPrev = x;
    yPrev = y;
  }

  return firstLayerMoves;
}

function generateSVG(movesByType, lineWidthMM, typeColors, padding = 5, backgroundColor = null) {
  const allPoints = Object.values(movesByType).flat(2);
  const allX = allPoints.map(p => p[0]);
  const allY = allPoints.map(p => p[1]);
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);
  const width = (maxX - minX) + 2 * padding;
  const height = (maxY - minY) + 2 * padding;

  const scaleInput = document.getElementById('resolutionMultiplier');
  const scale = parseFloat(scaleInput?.value || 10);

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', width * scale);
  svg.setAttribute('height', height * scale);
  svg.setAttribute('viewBox', `${minX - padding} ${minY - padding} ${width} ${height}`);

  // Add background rectangle if backgroundColor is set (not transparent)
  if (backgroundColor) {
    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', minX - padding);
    rect.setAttribute('y', minY - padding);
    rect.setAttribute('width', width);
    rect.setAttribute('height', height);
    rect.setAttribute('fill', backgroundColor);
    svg.appendChild(rect);
  }

  for (const [type, segments] of Object.entries(movesByType)) {
    const color = typeColors[type] || 'black';
    for (const [[x1, y1], [x2, y2]] of segments) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', (maxY + padding) - (y1 - (minY - padding)));
      line.setAttribute('x2', x2);
      line.setAttribute('y2', (maxY + padding) - (y2 - (minY - padding)));
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', lineWidthMM);
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
    }
  }
  return svg;
}

// rest of file unchanged


function svgToPng(svgElement, width, height, callback) {
  const svgData = new XMLSerializer().serializeToString(svgElement);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    URL.revokeObjectURL(url);
    callback(canvas);
  };
  img.onerror = () => {
    console.error('Failed to load SVG image');
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

// Default settings
const DEFAULT_SETTINGS = {
  lineWidth: '0.4',
  resolutionMultiplier: '10',
  outputFormat: 'svg',
  colorPerimeter: '#ffe64d',
  colorExternalPerimeter: '#ff7d38',
  colorInfill: '#b03029',
  colorSolidInfill: '#9654cc',
  colorBackground: '#424444',
  transparentBackground: true,
  currentTheme: 'default'
};

// Theme definitions
const THEMES = {
  default: {
    colorPerimeter: '#ffe64d',
    colorExternalPerimeter: '#ff7d38',
    colorInfill: '#b03029',
    colorSolidInfill: '#9654cc',
    colorBackground: '#ffffff',
    transparentBackground: true
  },
  solarFlare: {
    colorPerimeter: '#FFFFFF',
    colorExternalPerimeter: '#FF5500',
    colorInfill: '#3F00FF',
    colorSolidInfill: '#3F00FF',
    colorBackground: '#424444',
    transparentBackground: false
  },
  toxicPunch: {
    colorPerimeter: '#39FF14',
    colorExternalPerimeter: '#FFFF00',
    colorInfill: '#4B0082',
    colorSolidInfill: '#4B0082',
    colorBackground: '#424444',
    transparentBackground: false
  },
  cyberpunk: {
    colorPerimeter: '#FF69B4',
    colorExternalPerimeter: '#00FFFF',
    colorInfill: '#DA70D6',
    colorSolidInfill: '#DA70D6',
    colorBackground: '#424444',
    transparentBackground: false
  },
  monochromePop: {
    colorPerimeter: '#D3D3D3',
    colorExternalPerimeter: '#FFFFFF',
    colorInfill: '#AAAAAA',
    colorSolidInfill: '#AAAAAA',
    colorBackground: '#424444',
    transparentBackground: false
  }
};

// Settings management
function saveSettings() {
  const settings = {
    lineWidth: document.getElementById('lineWidth').value,
    resolutionMultiplier: document.getElementById('resolutionMultiplier').value,
    outputFormat: document.getElementById('outputFormat').value,
    colorPerimeter: document.getElementById('colorPerimeter').value,
    colorExternalPerimeter: document.getElementById('colorExternalPerimeter').value,
    colorInfill: document.getElementById('colorInfill').value,
    colorSolidInfill: document.getElementById('colorSolidInfill').value,
    colorBackground: document.getElementById('colorBackground').value,
    transparentBackground: document.getElementById('transparentBackground').checked,
    currentTheme: document.getElementById('themeSelector').value
  };
  localStorage.setItem('firstLayerRendererSettings', JSON.stringify(settings));
}

function loadSettings() {
  const savedSettings = localStorage.getItem('firstLayerRendererSettings');
  if (savedSettings) {
    const settings = JSON.parse(savedSettings);
    document.getElementById('lineWidth').value = settings.lineWidth;
    document.getElementById('resolutionMultiplier').value = settings.resolutionMultiplier;
    document.getElementById('outputFormat').value = settings.outputFormat;
    document.getElementById('colorPerimeter').value = settings.colorPerimeter;
    document.getElementById('colorExternalPerimeter').value = settings.colorExternalPerimeter;
    document.getElementById('colorInfill').value = settings.colorInfill;
    document.getElementById('colorSolidInfill').value = settings.colorSolidInfill;
    document.getElementById('colorBackground').value = settings.colorBackground;
    document.getElementById('transparentBackground').checked = settings.transparentBackground;
    document.getElementById('themeSelector').value = settings.currentTheme || 'default';
  }
}

function resetSettings() {
  // Apply default settings
  document.getElementById('lineWidth').value = DEFAULT_SETTINGS.lineWidth;
  document.getElementById('resolutionMultiplier').value = DEFAULT_SETTINGS.resolutionMultiplier;
  document.getElementById('outputFormat').value = DEFAULT_SETTINGS.outputFormat;
  document.getElementById('colorPerimeter').value = DEFAULT_SETTINGS.colorPerimeter;
  document.getElementById('colorExternalPerimeter').value = DEFAULT_SETTINGS.colorExternalPerimeter;
  document.getElementById('colorInfill').value = DEFAULT_SETTINGS.colorInfill;
  document.getElementById('colorSolidInfill').value = DEFAULT_SETTINGS.colorSolidInfill;
  document.getElementById('colorBackground').value = DEFAULT_SETTINGS.colorBackground;
  document.getElementById('transparentBackground').checked = DEFAULT_SETTINGS.transparentBackground;
  document.getElementById('themeSelector').value = DEFAULT_SETTINGS.currentTheme;
  
  // Save the default settings
  saveSettings();
}

function applyTheme(themeName) {
  const theme = THEMES[themeName];
  if (theme) {
    document.getElementById('colorPerimeter').value = theme.colorPerimeter;
    document.getElementById('colorExternalPerimeter').value = theme.colorExternalPerimeter;
    document.getElementById('colorInfill').value = theme.colorInfill;
    document.getElementById('colorSolidInfill').value = theme.colorSolidInfill;
    document.getElementById('colorBackground').value = theme.colorBackground;
    document.getElementById('transparentBackground').checked = theme.transparentBackground;
    saveSettings();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('gcodeInput');
  const output = document.getElementById('output');
  const renderButton = document.getElementById('renderButton');
  const downloadLink = document.getElementById('downloadLink');
  const colorBackground = document.getElementById('colorBackground');
  const transparentBackground = document.getElementById('transparentBackground');
  const themeSelector = document.getElementById('themeSelector');

  // Load saved settings when page loads
  loadSettings();

  // Add change event listeners to all settings inputs to save when changed
  const settingsInputs = [
    'lineWidth',
    'resolutionMultiplier',
    'outputFormat',
    'colorPerimeter',
    'colorExternalPerimeter',
    'colorInfill',
    'colorSolidInfill',
    'colorBackground',
    'transparentBackground',
    'themeSelector'
  ];

  settingsInputs.forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      if (id === 'themeSelector') {
        applyTheme(document.getElementById('themeSelector').value);
      }
      saveSettings();
    });
  });

  // Add reset button event listener
  document.getElementById('resetSettings').addEventListener('click', resetSettings);

  let gcodeText = '';

  input.addEventListener('change', event => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      gcodeText = e.target.result;
      input.dataset.filename = file.name; // Store original filename
    };
    reader.readAsText(file);
  });

  renderButton.addEventListener('click', () => {
    if (!gcodeText) return;

    const lineWidth = parseFloat(document.getElementById('lineWidth').value) || 0.4;
    const outputFormat = document.getElementById('outputFormat').value;
    const typeColors = {
      'perimeter': document.getElementById('colorPerimeter').value,
      'external perimeter': document.getElementById('colorExternalPerimeter').value,
      'infill': document.getElementById('colorInfill').value,
      'solid infill': document.getElementById('colorSolidInfill').value,
      'unknown': 'black'
    };

    // --- ADD THIS BLOCK ---
    let backgroundColor = null;
    if (!transparentBackground.checked) {
      backgroundColor = colorBackground.value || "#ffffff";
    }
    // ----------------------

    const moves = parseGCode(gcodeText);
    // Pass backgroundColor as the 5th argument
    const svg = generateSVG(moves, lineWidth, typeColors, 5, backgroundColor);

    output.innerHTML = '';

    // Helper to format date/time
    function getTimestampedName(originalName, ext) {
      const now = new Date();
      const pad = n => n.toString().padStart(2, '0');
      const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const base = originalName ? originalName.replace(/\.[^/.]+$/, "") : "output";
      return `${date}_${time}_${base}.${ext}`;
    }

    const originalName = input.dataset.filename || "output.gcode";

    if (outputFormat === 'svg') {
      output.appendChild(svg);
      const svgBlob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(svgBlob);
      downloadLink.href = url;
      downloadLink.download = getTimestampedName(originalName, "svg");
      downloadLink.textContent = 'Download SVG';
      downloadLink.style.display = 'inline-block';
    } else if (outputFormat === 'png') {
      const bbox = svg.viewBox.baseVal;
      svgToPng(svg, svg.width.baseVal.value, svg.height.baseVal.value, canvas => {
        output.appendChild(canvas);
        canvas.toBlob(blob => {
          const url = URL.createObjectURL(blob);
          downloadLink.href = url;
          downloadLink.download = getTimestampedName(originalName, "png");
          downloadLink.textContent = 'Download PNG';
          downloadLink.style.display = 'inline-block';
        });
      });
    }
  });
  fetch('default_logo.gcode')
    .then(res => res.text())
    .then(text => {
      gcodeText = text;
      input.dataset.filename = 'default_logo.gcode';
      renderButton.click();
    })
    .catch(err => console.warn('Could not load default Logo G-code:', err));
});
