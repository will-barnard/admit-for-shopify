import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './assets/styles.css';
import { FontAwesomeIcon } from './fontawesome';
import { installAxiosInterceptors, isEmbedded } from './shopify';

// Must run before anything issues a request. In the Shopify admin this attaches
// a session token to every axios call; standalone it is a no-op.
installAxiosInterceptors();
if (isEmbedded()) {
  document.documentElement.classList.add('shopify-embedded');
}

const app = createApp(App);

app.component('font-awesome-icon', FontAwesomeIcon);
app.use(createPinia());
app.use(router);

app.mount('#app');
