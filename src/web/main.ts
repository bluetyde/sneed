import './ui/style.css';
import { httpApi } from './api.js';
import { Editor } from './model/editor.js';
import { mountShell } from './ui/shell.js';

const root = document.getElementById('app');
if (!root) throw new Error('the page has no #app element');
mountShell(root, new Editor(httpApi()));
