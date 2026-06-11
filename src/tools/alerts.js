import {z} from 'zod';
import {registerTool} from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
    registerTool(server, 'alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
    }, ({condition, price, message}) => core.create({condition, price, message}));

    registerTool(server, 'alert_list', 'List active alerts', {}, () => core.list());

    registerTool(server, 'alert_delete', 'Delete all alerts or open context menu for deletion', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
    }, ({delete_all}) => core.deleteAlerts({delete_all}));

    registerTool(server, 'alert_activate', 'Reactivate an inactive (already-fired or stopped) alert by ID. Use alert_list to find the alert_id.', {
    alert_id: z.coerce.number().describe('Numeric alert_id from alert_list output'),
    }, ({alert_id}) => core.activate({alert_id}));
}
