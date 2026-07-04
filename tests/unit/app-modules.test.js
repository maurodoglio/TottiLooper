import { describe, expect, test } from 'vitest';

import { createExporter } from '../../src/exporter.js';
import { createMetronome } from '../../src/metronome.js';
import { createMixer } from '../../src/mixer.js';
import { createRecorder } from '../../src/recorder.js';
import { createUI } from '../../src/ui.js';

describe('app module split', () => {
  test('exports the expected module factories', () => {
    expect(createExporter).toBeTypeOf('function');
    expect(createMetronome).toBeTypeOf('function');
    expect(createMixer).toBeTypeOf('function');
    expect(createRecorder).toBeTypeOf('function');
    expect(createUI).toBeTypeOf('function');
  });
});
