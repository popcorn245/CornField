import '../src/index';

const maps = [...document.querySelectorAll<HTMLElement & { topology: unknown }>('corn-map')];
const log = document.querySelector('#log')!;
const topology = await (await fetch('/demo/topology.json')).json();
for (const map of maps) {
  map.topology = topology;
  map.addEventListener('cornSelect', (e) => { const { id, kind } = (e as CustomEvent).detail; log.textContent = `${map.id}: ${id ? `${kind} ${id}` : 'cleared'}`; });
  map.addEventListener('cornReady', () => { map.dataset.ready = ''; });
}
document.querySelector('#fit')!.addEventListener('click', () => maps.forEach((m: any) => m.fit()));
document.querySelector('#flow')!.addEventListener('click', () => maps.forEach((m: any) => { m.view = m.view === 'dataflow' ? 'map' : 'dataflow'; }));
