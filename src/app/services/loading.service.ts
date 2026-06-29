import { Injectable } from '@angular/core';
import { LoadingOptions } from '@ionic/angular';

@Injectable({
  providedIn: 'root'
})
export class LoadingService {
  private overlayElement: HTMLElement | null = null;

  async show(message: string = '', options: LoadingOptions = {}): Promise<void> {
    await this.dismiss();

    const overlay = document.createElement('div');
    overlay.className = 'trm-loading-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('aria-busy', 'true');

    const content = document.createElement('div');
    content.className = 'trm-loading-content';

    const spinner = document.createElement('div');
    spinner.className = 'trm-loading-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    content.appendChild(spinner);

    if (message && message.trim()) {
      const messageEl = document.createElement('div');
      messageEl.className = 'trm-loading-message';
      messageEl.textContent = message.trim();
      content.appendChild(messageEl);
    }

    overlay.appendChild(content);
    document.body.appendChild(overlay);
    this.overlayElement = overlay;

    // Force a reflow so the opacity transition plays
    overlay.getBoundingClientRect();
    overlay.classList.add('active');
  }

  async dismiss(): Promise<void> {
    if (!this.overlayElement) {
      return;
    }

    const overlay = this.overlayElement;
    this.overlayElement = null;

    overlay.classList.remove('active');
    await this.waitForTransition(overlay);

    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  }

  async withLoading<T>(
    message: string,
    operation: () => Promise<T>,
    options: LoadingOptions = {}
  ): Promise<T> {
    try {
      await this.show(message, options);
      return await operation();
    } finally {
      await this.dismiss();
    }
  }

  private waitForTransition(element: HTMLElement): Promise<void> {
    return new Promise(resolve => {
      const handler = () => {
        element.removeEventListener('transitionend', handler);
        resolve();
      };
      element.addEventListener('transitionend', handler);
      setTimeout(resolve, 250);
    });
  }
}
