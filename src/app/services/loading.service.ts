import { Injectable } from '@angular/core';
import { LoadingController, LoadingOptions } from '@ionic/angular';

@Injectable({
  providedIn: 'root'
})
export class LoadingService {
  private loadingElement: HTMLIonLoadingElement | null = null;

  constructor(private loadingController: LoadingController) {}

  async show(message: string = 'Loading...', options: LoadingOptions = {}): Promise<void> {
    // Dismiss any existing loading first to prevent stuck spinners
    await this.dismiss();

    const loadingOptions: LoadingOptions = {
      message,
      spinner: 'crescent',
      backdropDismiss: false,
      ...options
    };

    this.loadingElement = await this.loadingController.create(loadingOptions);
    await this.loadingElement.present();
  }

  async dismiss(): Promise<void> {
    if (this.loadingElement) {
      try {
        await this.loadingElement.dismiss();
      } catch (error) {
        // Ignore dismiss errors (already dismissed, etc.)
      } finally {
        this.loadingElement = null;
      }
    }
  }

  async withLoading<T>(
    message: string,
    operation: () => Promise<T>,
    options: LoadingOptions = {}
  ): Promise<T> {
    try {
      await this.show(message, options);
      const result = await operation();
      return result;
    } finally {
      await this.dismiss();
    }
  }
}
