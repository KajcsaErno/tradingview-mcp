import {z} from 'zod';
import {registerTool} from './_format.js';
import * as core from '../core/drawing.js';

export function registerDrawingTools(server) {
    registerTool(server, 'draw_shape', 'Draw a shape/line on the chart', {
    shape: z.string().describe('Shape type: horizontal_line, vertical_line, trend_line, rectangle, text'),
    point: z.object({ time: z.coerce.number(), price: z.coerce.number() }).describe('{ time: unix_timestamp, price: number }'),
    point2: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('Second point for two-point shapes (trend_line, rectangle)'),
    overrides: z.string().optional().describe('JSON string of style overrides (e.g., \'{"linecolor": "#ff0000", "linewidth": 2}\')'),
    text: z.string().optional().describe('Text content for text shapes'),
    }, ({shape, point, point2, overrides, text}) => core.drawShape({shape, point, point2, overrides, text}));

    registerTool(server, 'draw_list', 'List all shapes/drawings on the chart', {}, () => core.listDrawings());

    registerTool(server, 'draw_clear', 'Remove all drawings from the chart', {}, () => core.clearAll());

    registerTool(server, 'draw_remove_one', 'Remove a specific drawing by entity ID', {
    entity_id: z.string().describe('Entity ID of the drawing to remove (from draw_list)'),
    }, ({entity_id}) => core.removeOne({entity_id}));

    registerTool(server, 'draw_get_properties', 'Get properties and points of a specific drawing', {
    entity_id: z.string().describe('Entity ID of the drawing (from draw_list)'),
    }, ({entity_id}) => core.getProperties({entity_id}));
}
