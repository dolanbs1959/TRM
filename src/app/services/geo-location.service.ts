import { Injectable } from '@angular/core';

export interface GeoCoords {
  lat: number;
  lng: number;
}

@Injectable({ providedIn: 'root' })
export class GeoLocationService {

  private static readonly EARTH_RADIUS_METERS = 6_371_000;
  private static readonly FEET_PER_METER = 3.28084;
  private static readonly METERS_PER_MILE = 1609.344;

  /**
   * Haversine great-circle distance in meters between two lat/lng points.
   */
  haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return GeoLocationService.EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Parse a "lat,lng" coordinate string into a GeoCoords object.
   * Returns null if the string is missing, 'Unavailable', or not valid numbers.
   */
  parseCoords(coordString: string | null | undefined): GeoCoords | null {
    const s = String(coordString || '').trim();
    if (!s || s === 'Unavailable') {
      return null;
    }
    const parts = s.split(',');
    if (parts.length < 2) {
      return null;
    }
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    return { lat, lng };
  }

  /**
   * Extract stored job coordinates from a QuickBase service order record.
   * FID 157 = Latitude, FID 158 = Longitude.
   * Returns null if either field is missing or not a valid number.
   */
  getJobCoords(job: any): GeoCoords | null {
    const lat = Number(job?.['157']?.value);
    const lng = Number(job?.['158']?.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      return null;
    }
    return { lat, lng };
  }

  /**
   * Returns true if the technician is within `thresholdMeters` of the job.
   */
  isWithinMeters(techCoords: GeoCoords, jobLat: number, jobLng: number, thresholdMeters: number): boolean {
    return this.haversineMeters(techCoords.lat, techCoords.lng, jobLat, jobLng) <= thresholdMeters;
  }

  feetToMeters(feet: number): number {
    return feet / GeoLocationService.FEET_PER_METER;
  }

  metersToFeet(meters: number): number {
    return meters * GeoLocationService.FEET_PER_METER;
  }

  /**
   * Human-readable distance string.
   * < 1000 ft  → "450 feet"
   * >= 1000 ft → "0.3 miles"
   */
  formatDistance(meters: number): string {
    const feet = this.metersToFeet(meters);
    if (feet < 1000) {
      return `${Math.round(feet)} feet`;
    }
    const miles = meters / GeoLocationService.METERS_PER_MILE;
    return `${miles.toFixed(1)} mile${miles >= 2 ? 's' : ''}`;
  }
}
