import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { h } from 'vue';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import './tokens.css';
import BenchmarkChart from './BenchmarkChart.vue';
import HomeStage from './HomeStage.vue';
import HowItWorks from './HowItWorks.vue';
import SupportTable from './SupportTable.vue';

const theme: Theme = {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-after': () => h(HomeStage) }),
  enhanceApp({ app }) {
    app.component('SupportTable', SupportTable);
    app.component('BenchmarkChart', BenchmarkChart);
    app.component('HowItWorks', HowItWorks);
  },
};

export default theme;
