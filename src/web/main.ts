import './ui/style.css';
import { httpApi } from './api.js';
import { Editor } from './model/editor.js';
import { EventTreeEditor } from './model/event-tree-editor.js';
import { mountShell } from './ui/shell.js';

const root = document.getElementById('app');
if (!root) throw new Error('the page has no #app element');
const api = httpApi();
mountShell(root, new Editor(api), new EventTreeEditor(api));
