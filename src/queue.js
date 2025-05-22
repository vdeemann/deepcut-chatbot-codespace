class Queue {
    constructor() {
      this.items = [];
    }
  
    // Add element to end of queue
    enqueue(element) {
      this.items.push(element);
    }
  
    // Remove element from front of queue
    dequeue() {
      if (this.isEmpty()) {
        return null;
      }
      return this.items.shift();
    }
  
    // Get front element without removing it
    peek() {
      if (this.isEmpty()) {
        return null;
      }
      return this.items[0];
    }
  
    // Check if queue is empty
    isEmpty() {
      return this.items.length === 0;
    }
  
    // Get size of queue
    size() {
      return this.items.length;
    }
  
    // Clear the queue
    clear() {
      this.items = [];
    }
  
    // Print all elements in the queue
    print() {
      if (this.isEmpty()) {
        return "Queue is empty";
      }
      return this.items.join(", ");
    }
  
    // Check if an element exists in the queue
    contains(element) {
      return this.items.includes(element);
    }
  
    // Remove specific element from queue
    remove(element) {
      const index = this.items.indexOf(element);
      if (index !== -1) {
        return this.items.splice(index, 1)[0];
      }
      return null;
    }
  }
  
  module.exports = Queue;
  