/** The address search */
export async function search(q) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json`);
  return res.json();
}
