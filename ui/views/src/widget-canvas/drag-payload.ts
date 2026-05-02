export interface WidgetDragPayload {
  widgetId: string;
}

export interface DataTransferLike {
  getData(type: string): string;
  setData(type: string, data: string): void;
}

export const WIDGET_DRAG_DATA_TYPE = 'application/vnd.makaio.widget+json';

const isWidgetDragPayload = (value: unknown): value is WidgetDragPayload => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return typeof (value as { widgetId?: unknown }).widgetId === 'string';
};

export const setWidgetDragData = (dataTransfer: DataTransferLike, payload: WidgetDragPayload): void => {
  dataTransfer.setData(WIDGET_DRAG_DATA_TYPE, JSON.stringify(payload));
};

export const getWidgetDragData = (dataTransfer: DataTransferLike | null | undefined): WidgetDragPayload | null => {
  if (!dataTransfer) {
    return null;
  }

  const raw = dataTransfer.getData(WIDGET_DRAG_DATA_TYPE);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isWidgetDragPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
