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

// The review: the same map and one of its proposals, handed in as objects, so no cornfield server is asked for anything (the decision says so in words).
// With `src` instead (`<corn-review src="https://map.example.com" proposal="0042-retire-the-old-export">`) it reads a server and decides on it.
const review = document.querySelector<HTMLElement & { topology: unknown; proposal: unknown }>('#review')!;
review.addEventListener('cornReady', () => { review.dataset.ready = ''; });
review.addEventListener('cornNavigate', (e) => { const { change, view } = (e as CustomEvent).detail; log.textContent = `review: ${change}${view ? ` (${view})` : ''}`; });
review.topology = topology;
review.proposal = await (await fetch('/demo/proposal.json')).json();
