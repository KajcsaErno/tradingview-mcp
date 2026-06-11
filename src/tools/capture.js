import {z} from 'zod';
import {registerTool} from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
    registerTool(server, 'capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    }, ({region, filename, method}) => core.captureScreenshot({region, filename, method}));
}
