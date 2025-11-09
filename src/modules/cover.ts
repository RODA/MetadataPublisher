
export const cover = {

    addCover: (text?: string) => {
        document.body.classList.add('stop-scrolling');
        const loaderEl = document.getElementById('loader') as HTMLDivElement | null;
        if (loaderEl) {
            if (typeof text === 'string') loaderEl.textContent = text;
            loaderEl.classList.remove('hidden');
        }
        const coverEl = document.getElementById('cover') as HTMLDivElement | null;
        if (coverEl) coverEl.classList.remove('hidden');
    },

    removeCover: () => {
        document.body.classList.remove('stop-scrolling');
            const loaderEl = document.getElementById('loader') as HTMLDivElement | null;
            if (loaderEl) {
                loaderEl.classList.add('hidden');
                loaderEl.textContent = '';
            }
            const coverEl = document.getElementById('cover') as HTMLDivElement | null;
            if (coverEl) coverEl.classList.add('hidden');
    }

}

