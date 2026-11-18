import './ui/styles.css';
import { App } from './ui/app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('#app 根节点不存在');

new App(root);
