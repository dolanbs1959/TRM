import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router'; 
import { AuthService } from '../services/auth.service';
import { APP_VERSION } from '../app.version';

@Component({
  selector: 'app-login',
  templateUrl: './login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: false, // Change this to false
})
export class LoginPage implements OnInit {
  phoneNumber: string = '';
  pin: string = '';
  
  // Add these two lines to fix the error
  isLoggingIn: boolean = false;
  firstName: string = '';
  sessionStateWarning: string = '';
  appVersion: string = APP_VERSION;

  constructor(private authService: AuthService, private router: Router) { }

  ngOnInit() {
    this.authService.clearLoginSession();
    this.updateSessionStateWarning();
  }

  ionViewWillEnter() {
    this.authService.clearLoginSession();
    this.resetLoginViewState();
    this.updateSessionStateWarning();
  }

  async onLogin() {
    this.isLoggingIn = true;
    console.log('Attempting login for:', this.phoneNumber);
    
    const success = await this.authService.login(this.phoneNumber, this.pin);
    
    if (success) {
      this.firstName = this.authService.getUser()?.[6]?.value || '';
      console.log('Login success! Welcome,', this.firstName);
      this.router.navigate(['/home']);
    } else {
      this.isLoggingIn = false;
      console.error('Login failed. Check your credentials.');
    }
  }

  private resetLoginViewState() {
    this.isLoggingIn = false;
    this.firstName = '';
    this.pin = '';
  }

  private getTodayDateKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getDateKeyFromTimestamp(value: unknown): string | null {
    const parsedNumber = Number(value);
    if (!Number.isFinite(parsedNumber)) {
      return null;
    }

    const date = new Date(parsedNumber);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private clearPersistedWorkflowState() {
    localStorage.removeItem('trm.homeState');
    localStorage.removeItem('trm.homeState.jobIndexes');
    localStorage.removeItem('trm.activeJobId');
    localStorage.removeItem('trm.activeJobMode');
    localStorage.removeItem('trm.activeJobPaused');
  }

  private updateSessionStateWarning() {
    let wasClockedIn = false;
    let hasEnRouteJob = false;
    let hasInProgressJob = false;
    let stateDateKey = '';
    let hasPersistedState = false;

    try {
      const rawState = localStorage.getItem('trm.homeState');
      const parsedState = rawState ? JSON.parse(rawState) : null;
      if (parsedState && typeof parsedState === 'object') {
        hasPersistedState = true;
      }

      stateDateKey = String(parsedState?.dateKey || '').trim();
      if (!stateDateKey) {
        stateDateKey = this.getDateKeyFromTimestamp(parsedState?.clockInStartedAtMs) || '';
      }

      const hasActiveTimecardContext = !!parsedState?.activeTimecardRecordId
        && Number.isFinite(Number(parsedState?.clockInStartedAtMs));
      wasClockedIn = !!parsedState?.isClockedIn && hasActiveTimecardContext;
    } catch {}

    try {
      const rawIndexes = localStorage.getItem('trm.homeState.jobIndexes');
      const parsedIndexes = rawIndexes ? JSON.parse(rawIndexes) : null;
      if (parsedIndexes && typeof parsedIndexes === 'object') {
        hasPersistedState = true;
        for (const value of Object.values(parsedIndexes) as Array<any>) {
          const actionIndex = typeof value === 'number'
            ? value
            : Number(value?.actionIndex || 0);

          if (actionIndex === 1) {
            hasEnRouteJob = true;
          }

          if (actionIndex === 2) {
            hasInProgressJob = true;
          }
        }
      }
    } catch {}

    const todayDateKey = this.getTodayDateKey();
    if (hasPersistedState && stateDateKey && stateDateKey !== todayDateKey) {
      this.clearPersistedWorkflowState();
      this.sessionStateWarning = '';
      return;
    }

    const reasons: string[] = [];
    if (wasClockedIn) {
      reasons.push('the previous session ended while still CLOCKED IN');
    }

    if (hasInProgressJob) {
      reasons.push('a job was left in In Progress status');
    } else if (hasEnRouteJob) {
      reasons.push('a job was left in En Route status');
    }

    if (reasons.length === 0) {
      this.sessionStateWarning = '';
      return;
    }

    this.sessionStateWarning = `Action required: ${reasons.join(' and ')}. Please contact the Office before proceeding.`;
  }
}
