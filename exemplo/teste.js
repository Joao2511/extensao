// Selecione a função abaixo e pressione Ctrl+Alt+A para treinar.

function somaPares(numeros) {
  let total = 0;
  for (const n of numeros) {
    if (n % 2 === 0) {
      total += n;
    }
  }
  return total;
}

console.log(somaPares([1, 2, 3, 4, 5, 6]));
