import { mapFilePath, parseRange } from './map-files';

describe('mapFilePath', () => {
  it('acepta el mapa, las fuentes y los sprites', () => {
    expect(mapFilePath(['peru.pmtiles'])).toEqual({ path: 'peru.pmtiles', type: 'application/vnd.pmtiles' });
    expect(mapFilePath(['fuentes', 'Noto Sans Regular', '0-255.pbf'])).toEqual({
      path: 'fuentes/Noto Sans Regular/0-255.pbf',
      type: 'application/x-protobuf',
    });
    expect(mapFilePath(['sprites', 'v4', 'light@2x.png'])?.type).toBe('image/png');
    expect(mapFilePath(['version.json'])?.type).toBe('application/json');
  });

  it('rechaza salir del directorio, ocultos, extensiones ajenas y rutas largas', () => {
    expect(mapFilePath(['..', 'etc', 'passwd.json'])).toBeNull();
    expect(mapFilePath(['fuentes', '..', 'peru.pmtiles'])).toBeNull();
    expect(mapFilePath(['a..b.json'])).toBeNull();
    expect(mapFilePath(['.env.json'])).toBeNull();
    expect(mapFilePath(['ATRIBUCION.txt'])).toBeNull();
    expect(mapFilePath(['peru'])).toBeNull();
    expect(mapFilePath(['a/b.json'])).toBeNull();
    expect(mapFilePath(['a%2F..json'])).toBeNull();
    expect(mapFilePath([])).toBeNull();
    expect(mapFilePath(['a', 'b', 'c', 'd', 'e.png'])).toBeNull();
  });
});

describe('parseRange', () => {
  it('sin cabecera: el archivo completo', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('', 100)).toBeNull();
  });

  it('rango cerrado, abierto y sufijo', () => {
    expect(parseRange('bytes=0-15', 100)).toEqual({ start: 0, end: 15 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('el fin se recorta al tamaño del archivo', () => {
    expect(parseRange('bytes=50-16383', 100)).toEqual({ start: 50, end: 99 });
  });

  it('fuera del archivo o mal formado: 416', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=20-10', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('unsatisfiable');
    expect(parseRange('items=0-1', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1', 0)).toBe('unsatisfiable');
  });
});
