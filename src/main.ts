import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { Capacitor } from '@capacitor/core';
import { defineCustomElements } from '@ionic/pwa-elements/loader';
import { AppModule } from './app/app.module';

if (Capacitor.getPlatform() === 'web') {
  defineCustomElements(window);
}

platformBrowserDynamic().bootstrapModule(AppModule)
  .catch(err => console.log(err));