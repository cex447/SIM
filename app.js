import { LINEAS } from "./config.js";

const demo = [

    {
        circulacion: "D103",
        linea: "S1",
        material: "112.08",
        recorrido: "PC→NA",
        posicion: "RB→FN",
        ocupacion: [10,35,60,90]
    },

    {
        circulacion: "F324",
        linea: "S2",
        material: "113.19",
        recorrido: "PN→PC",
        posicion: "CF→SQ",
        ocupacion: null
    }

];

render();

function render(){

    const contenedor =
        document.getElementById("circulaciones");

    contenedor.innerHTML = "";

    demo.forEach(tren=>{

        const fila =
            document.createElement("div");

        fila.className = "fila";

        fila.innerHTML = `
            <span class="circulacion"
                  style="color:${LINEAS[tren.linea].color}">
                ${tren.circulacion}
            </span>

            <span class="material">
                ${tren.material}
            </span>

            <span class="recorrido">
                ${tren.recorrido}
            </span>

            <span class="posicion">
                ${tren.posicion}
            </span>

            <span class="ocupacion">
                ${renderOcupacion(tren.ocupacion)}
            </span>
        `;

        contenedor.appendChild(fila);

    });

}