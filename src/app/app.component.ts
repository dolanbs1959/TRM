import { Component } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { camera, cameraOutline, closeOutline, refreshOutline } from 'ionicons/icons';
import { SwUpdate } from '@angular/service-worker';
import { AlertController } from '@ionic/angular';
import { Router, NavigationEnd } from '@angular/router';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  standalone: false, // Change this to false
})
export class AppComponent {
  private updateAvailable = false;
  private isUserEnteringData = false;
  private alertShown = false;

  constructor(
    private swUpdate: SwUpdate,
    private alertController: AlertController,
    private router: Router
  ) {
    addIcons({ camera, cameraOutline, closeOutline, refreshOutline });
    this.checkForUpdates();
    this.trackUserActivity();
  }

  private checkForUpdates() {
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates.subscribe((event) => {
        if (event.type === 'VERSION_READY') {
          this.updateAvailable = true;
          this.alertShown = false;
          this.tryShowUpdateAlert();
        }
      });
    }
  }

  private trackUserActivity() {
    // Track when user navigates to a new page (good time to show update alert)
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.isUserEnteringData = false;
        this.tryShowUpdateAlert();
      }
    });

    // Detect when user is actively entering data in inputs
    document.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLInputElement || 
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement) {
        this.isUserEnteringData = true;
      }
    });

    document.addEventListener('focusout', (event) => {
      if (event.target instanceof HTMLInputElement || 
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement) {
        // Small delay to ensure user has finished typing
        setTimeout(() => {
          this.isUserEnteringData = false;
          this.tryShowUpdateAlert();
        }, 2000);
      }
    });
  }

  private tryShowUpdateAlert() {
    if (this.updateAvailable && !this.isUserEnteringData && !this.alertShown) {
      this.showUpdateAlert();
    }
  }

  private async showUpdateAlert() {
    this.alertShown = true;
    const alert = await this.alertController.create({
      header: 'Update Available',
      message: 'A new version of TRM Mobile is available.',
      buttons: [
        {
          text: 'Later',
          role: 'cancel',
          handler: () => {
            // User chose to update later, reset alertShown so it can show again
            this.alertShown = false;
          },
        },
        {
          text: 'Update Now',
          handler: () => {
            this.activateUpdate();
          },
        },
      ],
    });

    await alert.present();
  }

  private activateUpdate() {
    this.swUpdate.activateUpdate().then(() => {
      window.location.reload();
    });
  }
}
