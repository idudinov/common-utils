import { onSchedule, type ScheduleOptions, type ScheduledEvent, type ScheduleFunction } from 'firebase-functions/v2/scheduler';
import type { EndpointSettings } from '../../../functions/interface.js';
import { mergeEndpointSettings } from './helpers.js';

export type ScheduledFunction = ((event: ScheduledEvent) => void | Promise<void>);
export type SchedulerOptions = { timeZone?: string, runtime?: EndpointSettings };

export function createScheduledFunction(schedule: string, worker: ScheduledFunction, options?: SchedulerOptions): ScheduleFunction {
    const scheduleOpts: ScheduleOptions = {
        schedule,
        ...mergeEndpointSettings(options?.runtime),
    };
    if (options?.timeZone) {
        scheduleOpts.timeZone = options.timeZone;
    }

    return onSchedule(scheduleOpts, (event) => worker(event));
}
