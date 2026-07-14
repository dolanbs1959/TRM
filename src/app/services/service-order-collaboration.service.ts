import { Injectable } from '@angular/core';
import { initializeApp, getApps, FirebaseApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, updateDoc, Firestore } from 'firebase/firestore';
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject, FirebaseStorage } from 'firebase/storage';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ServiceOrderCollaborationService {
  private app: FirebaseApp;
  private db: Firestore;
  private storage: FirebaseStorage;

  constructor() {
    const wasAlreadyInit = getApps().length > 0;
    this.app = wasAlreadyInit
      ? getApps()[0]
      : initializeApp(environment.firebase);
    this.db = getFirestore(this.app);
    this.storage = getStorage(this.app);

    // --- DIAGNOSTIC: remove after confirming connectivity ---
    console.log('[SOCollaboration] Firebase app already initialized before this service:', wasAlreadyInit);
    console.log('[SOCollaboration] App name:', this.app.name);
    console.log('[SOCollaboration] Project ID:', this.app.options['projectId']);
    console.log('[SOCollaboration] Storage bucket:', this.app.options['storageBucket']);
    console.log('[SOCollaboration] Auth domain:', this.app.options['authDomain']);
    console.log('[SOCollaboration] environment.firebase keys present:', Object.keys(environment.firebase));
    // --------------------------------------------------------
  }

  async uploadTaskPhoto(
    serviceOrderId: string,
    taskId: string,
    slot: 'before' | 'after',
    fileName: string,
    blob: Blob
  ): Promise<string> {
    const path = `service-orders/${serviceOrderId}/tasks/${taskId}/${slot}/${fileName}`;
    const fileRef = storageRef(this.storage, path);
    try {
      await uploadBytes(fileRef, blob, { contentType: 'image/jpeg' });
    } catch (err) {
      console.error('[uploadTaskPhoto] uploadBytes failed:', err);
      throw err;
    }
    try {
      const url = await getDownloadURL(fileRef);
      return url;
    } catch (err) {
      console.error('[uploadTaskPhoto] getDownloadURL failed:', err);
      throw err;
    }
  }

  async createSession(serviceOrderId: string): Promise<void> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const now = new Date().toISOString();
    const snapshot = await getDoc(ref);

    if (!snapshot.exists()) {
      await setDoc(ref, {
        serviceOrderId,
        createdAt: now,
        lastUpdated: now,
      });
    } else {
      await updateDoc(ref, { lastUpdated: now });
    }
  }

  async updateTaskNote(serviceOrderId: string, taskId: string, note: string): Promise<void> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      return;
    }
    await updateDoc(ref, {
      [`tasks.${taskId}.notes`]: note,
      lastUpdated: new Date().toISOString(),
    });
  }

  async getSessionTaskNotes(serviceOrderId: string): Promise<Record<string, string>> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      return {};
    }
    const tasks = snapshot.data()?.['tasks'] as Record<string, { notes?: string }> | undefined;
    if (!tasks || typeof tasks !== 'object') {
      return {};
    }
    const notes: Record<string, string> = {};
    for (const [taskId, taskData] of Object.entries(tasks)) {
      notes[taskId] = taskData?.notes ?? '';
    }
    return notes;
  }

  async addTaskPhoto(
    serviceOrderId: string,
    taskId: string,
    slot: 'before' | 'after',
    photo: { fileName: string; notes: string; capturedAt: number; storageUrl: string }
  ): Promise<void> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      return;
    }
    const existing = snapshot.data()?.['tasks']?.[taskId]?.['photos']?.[slot] ?? [];
    const updated = Array.isArray(existing) ? [...existing, photo] : [photo];
    await updateDoc(ref, {
      [`tasks.${taskId}.photos.${slot}`]: updated,
      lastUpdated: new Date().toISOString(),
    });
  }

  async deleteTaskPhoto(
    serviceOrderId: string,
    taskId: string,
    slot: 'before' | 'after',
    fileName: string
  ): Promise<void> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      return;
    }

    // Remove Firestore metadata
    const existing = snapshot.data()?.['tasks']?.[taskId]?.['photos']?.[slot] ?? [];
    const updated = Array.isArray(existing)
      ? existing.filter((p: any) => p?.fileName !== fileName)
      : [];
    await updateDoc(ref, {
      [`tasks.${taskId}.photos.${slot}`]: updated,
      lastUpdated: new Date().toISOString(),
    });

    // Remove Firebase Storage object
    const path = `service-orders/${serviceOrderId}/tasks/${taskId}/${slot}/${fileName}`;
    const fileRef = storageRef(this.storage, path);
    try {
      await deleteObject(fileRef);
    } catch (err) {
      console.warn('[SOCollaboration] Failed to delete storage object:', err);
      // Continue; Firestore is the source of truth for the UI.
    }
  }

  async getSessionTaskPhotos(
    serviceOrderId: string
  ): Promise<Record<string, { fileName: string; notes: string; capturedAt: number; storageUrl: string }[]>> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      return {};
    }
    const tasks = snapshot.data()?.['tasks'] as
      Record<string, { photos?: Record<string, { fileName: string; notes: string; capturedAt: number; storageUrl: string }[]> }>
      | undefined;
    if (!tasks || typeof tasks !== 'object') {
      return {};
    }
    const result: Record<string, { fileName: string; notes: string; capturedAt: number; storageUrl: string }[]> = {};
    for (const [taskId, taskData] of Object.entries(tasks)) {
      const photos = taskData?.photos;
      if (!photos || typeof photos !== 'object') {
        continue;
      }
      for (const slot of ['before', 'after'] as const) {
        if (Array.isArray(photos[slot]) && photos[slot].length > 0) {
          result[`${slot}-${taskId}`] = photos[slot];
        }
      }
    }
    return result;
  }

  async updateTaskFinished(serviceOrderId: string, taskId: string, finished: boolean): Promise<void> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      return;
    }
    await updateDoc(ref, {
      [`tasks.${taskId}.finished`]: finished,
      lastUpdated: new Date().toISOString(),
    });
  }

  async recordArrival(
    serviceOrderId: string,
    technicianId: string,
    technicianName: string
  ): Promise<void> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const now = new Date().toISOString();
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      await setDoc(ref, {
        serviceOrderId,
        createdAt: now,
        lastUpdated: now,
        arrivals: { [technicianId]: { technicianName, arrivedAt: now } },
      });
    } else {
      await updateDoc(ref, {
        [`arrivals.${technicianId}`]: { technicianName, arrivedAt: now },
        lastUpdated: now,
      });
    }
  }

  async getArrivalTimestamps(
    serviceOrderId: string
  ): Promise<Record<string, { technicianName: string; arrivedAt: string }>> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      return {};
    }
    const arrivals = snapshot.data()?.['arrivals'] as
      Record<string, { technicianName: string; arrivedAt: string }> | undefined;
    return arrivals && typeof arrivals === 'object' ? arrivals : {};
  }

  async getSessionFinishedTaskIds(serviceOrderId: string): Promise<string[]> {
    const ref = doc(this.db, 'serviceOrders', serviceOrderId);
    const snapshot = await getDoc(ref);
    if (!snapshot.exists()) {
      return [];
    }
    const tasks = snapshot.data()?.['tasks'] as Record<string, { finished?: boolean }> | undefined;
    if (!tasks || typeof tasks !== 'object') {
      return [];
    }
    return Object.entries(tasks)
      .filter(([, taskData]) => taskData?.finished === true)
      .map(([taskId]) => taskId);
  }
}
