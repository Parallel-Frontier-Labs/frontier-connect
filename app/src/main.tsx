import { render } from 'preact';
import { startFonts } from './fonts';
import { Root } from './Root';

// Ask for the fonts before the first render, so they load while the host connects.
render(<Root fonts={startFonts()} />, document.getElementById('root')!);
